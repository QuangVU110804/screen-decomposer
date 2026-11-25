const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sharp = require('sharp');

const config = require('../config');
const { formatTimecode } = require('../utils/ffmpeg');

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 80;

async function removeIfExists(target) {
  await fs.promises.rm(target, { recursive: true, force: true });
}

/** Copy một file có thể không tồn tại; trả về path đích nếu có, else null. */
async function copyOptional(source, dest) {
  try {
    await fs.promises.copyFile(source, dest);
    return dest;
  } catch (_err) {
    return null;
  }
}

async function finalizeAssets(job) {
  if (!job || !job.id) throw new Error('Job không hợp lệ khi hoàn tất asset');
  const finalDir = path.join(config.ASSET_DIR, String(job.id));
  const stagingDir = path.join(config.ASSET_DIR, `.staging-${job.id}-${randomUUID()}`);
  const sorted = [...(Array.isArray(job.assets) ? job.assets : [])]
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const sceneClips = Array.isArray(job.sceneClips) ? job.sceneClips : [];
  const finalized = [];

  await removeIfExists(finalDir);
  await removeIfExists(stagingDir);
  await fs.promises.mkdir(stagingDir, { recursive: true });

  try {
    for (let index = 0; index < sorted.length; index++) {
      const asset = sorted[index];
      if (!asset.framePath) throw new Error(`Asset ${index + 1} thiếu framePath`);
      const number = index + 1;
      const base = `asset_${String(number).padStart(3, '0')}`;
      const pngPath = path.join(stagingDir, `${base}.png`);
      const thumbPath = path.join(stagingDir, `${base}_thumb.jpg`);

      await fs.promises.copyFile(asset.framePath, pngPath);
      await sharp(asset.framePath, { failOn: 'none' })
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(thumbPath);

      // Copy video clip (if any) next to the still image.
      let clipPath = null;
      let clipPosterPath = null;
      if (asset.clipPath) {
        clipPath = await copyOptional(asset.clipPath, path.join(stagingDir, `${base}_clip.mp4`));
        if (asset.clipPosterPath) {
          clipPosterPath = await copyOptional(
            asset.clipPosterPath,
            path.join(stagingDir, `${base}_clip_poster.jpg`)
          );
        }
      }

      finalized.push({
        index: number,
        label: asset.label || '',
        description: asset.description || '',
        confidence: Number.isFinite(Number(asset.confidence)) ? Number(asset.confidence) : 0,
        timestamp: Number(asset.timestamp || 0),
        timecode: asset.timecode || formatTimecode(Number(asset.timestamp || 0)),
        framePath: path.join(finalDir, `${base}.png`),
        thumbPath: path.join(finalDir, `${base}_thumb.jpg`),
        clipPath: clipPath ? path.join(finalDir, `${base}_clip.mp4`) : null,
        clipPosterPath: clipPosterPath ? path.join(finalDir, `${base}_clip_poster.jpg`) : null,
        clipStart: Number(asset.clipStart || 0),
        clipEnd: Number(asset.clipEnd || 0),
        clipDuration: Number(asset.clipDuration || 0),
      });
    }

    // Copy scene clips into the archive dir so they download with the job.
    const finalizedSceneClips = [];
    for (let i = 0; i < sceneClips.length; i++) {
      const clip = sceneClips[i];
      const base = `clip_scene_${String(i + 1).padStart(3, '0')}`;
      const clipPath = await copyOptional(clip.clipPath, path.join(stagingDir, `${base}.mp4`));
      const posterPath = clip.posterPath
        ? await copyOptional(clip.posterPath, path.join(stagingDir, `${base}_poster.jpg`))
        : null;
      if (!clipPath) continue;
      finalizedSceneClips.push({
        index: i + 1,
        start: Number(clip.start || 0),
        end: Number(clip.end || 0),
        duration: Number(clip.duration || 0),
        timecode: clip.timecode || formatTimecode(Number(clip.start || 0)),
        clipPath: path.join(finalDir, `${base}.mp4`),
        posterPath,
      });
    }

    const manifest = {
      jobId: job.id,
      sourceType: job.sourceType || null,
      sourceUrl: job.sourceUrl || null,
      generatedAt: new Date().toISOString(),
      assetCount: finalized.length,
      assets: finalized.map((asset) => ({
        index: asset.index,
        label: asset.label,
        description: asset.description,
        timestamp: asset.timestamp,
        timecode: asset.timecode,
        confidence: asset.confidence,
        file: path.basename(asset.framePath),
        thumb: path.basename(asset.thumbPath),
        clip: asset.clipPath ? path.basename(asset.clipPath) : null,
        clipPoster: asset.clipPosterPath ? path.basename(asset.clipPosterPath) : null,
        clipDuration: asset.clipDuration,
      })),
      sceneClips: finalizedSceneClips.map((clip) => ({
        index: clip.index,
        start: clip.start,
        end: clip.end,
        duration: clip.duration,
        timecode: clip.timecode,
        file: path.basename(clip.clipPath),
        poster: clip.posterPath ? path.basename(clip.posterPath) : null,
      })),
    };
    await fs.promises.writeFile(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    await fs.promises.rename(stagingDir, finalDir);
    return { assets: finalized, sceneClips: finalizedSceneClips };
  } catch (err) {
    await removeIfExists(stagingDir).catch(() => {});
    throw err;
  }
}

module.exports = { THUMB_WIDTH, THUMB_QUALITY, finalizeAssets };
