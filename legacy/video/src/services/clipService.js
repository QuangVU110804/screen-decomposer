const fs = require('fs');
const path = require('path');

const config = require('../config');
const { cutClip, extractPoster, formatTimecode, parseSceneCuts, runFfmpeg } = require('../utils/ffmpeg');

const POSTER_WIDTH = 320;

function clipsDir(jobId) {
  return path.join(config.CANDIDATE_DIR, String(jobId), 'clips');
}

async function ensureClipsDir(jobId) {
  const dir = clipsDir(jobId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Chạy scene detection và trả về danh sách phân đoạn [{start, end}] giữa các
 * lần cắt cảnh. Segment ngắn hơn MIN_SCENE_CLIP_SEC bị bỏ vì không đáng làm clip.
 */
async function detectSceneSegments(videoPath, duration, options = {}) {
  const sceneThreshold = options.sceneThreshold ?? config.SCENE_THRESHOLD;
  const minClipSec = options.minSceneClipSec ?? config.MIN_SCENE_CLIP_SEC;
  const maxSegments = options.maxSegments ?? config.MAX_SCENE_CANDIDATES;

  const { stderr } = await runFfmpeg([
    '-hide_banner', '-nostats',
    '-i', videoPath,
    '-vf', `select='gt(scene,${sceneThreshold})',metadata=print`,
    '-fps_mode', 'passthrough',
    '-an', '-f', 'null', '-',
  ]);

  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const cuts = parseSceneCuts(stderr)
    .map((cut) => cut.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0 && (!total || timestamp < total))
    .sort((a, b) => a - b);

  // Boundaries are 0, every cut, then the end of the video.
  const boundaries = [0, ...cuts];
  if (total > 0) boundaries.push(total);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start < minClipSec) continue;
    segments.push({ start, end });
  }

  // Prefer the longest segments when a video has more cuts than we will keep,
  // then restore chronological order so clip numbering follows the video.
  return segments
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, maxSegments)
    .sort((a, b) => a.start - b.start);
}

/**
 * Cắt các phân đoạn scene thành file MP4 trong temp/candidates/<jobId>/clips.
 * Một clip lỗi không làm hỏng cả job — nó chỉ bị bỏ qua.
 */
async function extractSceneClips(jobId, videoPath, duration, onProgress, options = {}) {
  const segments = await detectSceneSegments(videoPath, duration, options);
  if (segments.length === 0) return [];

  const dir = await ensureClipsDir(jobId);
  const maxEdgePx = options.maxEdgePx ?? config.CLIP_MAX_EDGE_PX;
  const clips = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const base = `scene_${String(i + 1).padStart(3, '0')}`;
    const clipPath = path.join(dir, `${base}.mp4`);
    const posterPath = path.join(dir, `${base}_poster.jpg`);
    try {
      await cutClip(videoPath, segment.start, segment.end, clipPath, { maxEdgePx });
      await extractPoster(videoPath, segment.start, posterPath, { width: POSTER_WIDTH })
        .catch(() => {});
      clips.push({
        start: segment.start,
        end: segment.end,
        duration: Number((segment.end - segment.start).toFixed(3)),
        timecode: formatTimecode(segment.start),
        clipPath,
        posterPath: fs.existsSync(posterPath) ? posterPath : null,
      });
    } catch (err) {
      console.warn(`[clips ${jobId}] bỏ qua scene ${i + 1}: ${err.message}`);
    }
    if (onProgress) onProgress((i + 1) / segments.length);
  }

  return clips;
}

/**
 * Với mỗi asset đã được Vision xác nhận, cắt một clip ngắn quanh timestamp của
 * nó và gắn clipPath/posterPath vào asset. Trả về mảng asset mới.
 */
async function attachAssetClips(jobId, videoPath, assets, duration, onProgress, options = {}) {
  const list = Array.isArray(assets) ? assets : [];
  if (list.length === 0) return list;

  const dir = await ensureClipsDir(jobId);
  const padding = options.clipPaddingSec ?? config.CLIP_PADDING_SEC;
  const maxEdgePx = options.maxEdgePx ?? config.CLIP_MAX_EDGE_PX;
  const total = Number.isFinite(duration) && duration > 0 ? duration : null;
  const result = [];

  for (let i = 0; i < list.length; i++) {
    const asset = list[i];
    const timestamp = Number(asset.timestamp) || 0;
    // A still span tells us how long the asset is actually on screen; use it
    // when available so the clip covers the whole thing plus padding.
    const spanStart = Number.isFinite(asset.spanStart) ? asset.spanStart : timestamp;
    const spanEnd = Number.isFinite(asset.spanEnd) && asset.spanEnd > spanStart
      ? asset.spanEnd
      : timestamp;
    const start = Math.max(0, spanStart - padding);
    const rawEnd = spanEnd + padding;
    const end = total ? Math.min(total, rawEnd) : rawEnd;
    if (end - start <= 0.05) {
      result.push(asset);
      continue;
    }

    const base = `asset_${String(i + 1).padStart(3, '0')}`;
    const clipPath = path.join(dir, `${base}.mp4`);
    const posterPath = path.join(dir, `${base}_poster.jpg`);
    try {
      await cutClip(videoPath, start, end, clipPath, { maxEdgePx });
      await extractPoster(videoPath, start, posterPath, { width: POSTER_WIDTH }).catch(() => {});
      result.push({
        ...asset,
        clipPath,
        clipPosterPath: fs.existsSync(posterPath) ? posterPath : null,
        clipStart: start,
        clipEnd: end,
        clipDuration: Number((end - start).toFixed(3)),
      });
    } catch (err) {
      console.warn(`[clips ${jobId}] bỏ qua clip asset ${i + 1}: ${err.message}`);
      result.push(asset);
    }
    if (onProgress) onProgress((i + 1) / list.length);
  }

  return result;
}

/**
 * Trích xuất toàn bộ clips cho một job khi video còn tồn tại:
 *   1. Scene clips — mỗi phân đoạn giữa hai scene cuts.
 *   2. Asset clips — clip ngắn quanh mỗi asset đã được Vision xác nhận.
 *
 * Được gọi SAU Vision nhưng TRƯỚC khi unlink video, vì cả hai loại clip đều
 * cần video nguồn. Trả về { assets, clips } với clips là danh sách scene clip.
 */
async function extractClips(jobId, videoPath, assets, duration, onProgress, options = {}) {
  const report = onProgress || (() => {});
  report(0, 'clips');

  // 1) Scene clips
  const sceneClips = await extractSceneClips(jobId, videoPath, duration, (f) => report(f * 0.5, 'clips'), options);

  // 2) Asset clips cho các asset được confirm (sau Vision)
  const withClips = await attachAssetClips(jobId, videoPath, assets, duration, (f) => report(0.5 + f * 0.5, 'clips'), options);

  report(1, 'clips');
  return { assets: withClips, clips: sceneClips };
}

module.exports = {
  POSTER_WIDTH,
  clipsDir,
  detectSceneSegments,
  extractSceneClips,
  attachAssetClips,
  extractClips,
};
