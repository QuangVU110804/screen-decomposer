const { spawn } = require('child_process');
const path = require('path');
const { FFMPEG_PATH, FFPROBE_PATH } = require('../config');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let proc;
    try {
      proc = spawn(FFMPEG_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); });
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const tail = stderr.slice(-500);
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let proc;
    try {
      proc = spawn(FFPROBE_PATH, args);
    } catch (err) {
      reject(err);
      return;
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); });
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const tail = stderr.slice(-500) || stdout.slice(-500);
        reject(new Error(`ffprobe exited with code ${code}: ${tail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function formatTimecode(sec) {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function parseTimecode(tc) {
  const s = tc.trim();
  const parts = s.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(s);
}

function parseFreezeDetect(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const spans = [];
  const pendingStarts = [];

  for (const line of lines) {
    const mStart = line.match(/freeze_start:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    if (mStart) {
      pendingStarts.push(parseFloat(mStart[1]));
    }
    const mEnd = line.match(/freeze_end:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    if (mEnd) {
      const start = pendingStarts.shift();
      if (start !== undefined) {
        spans.push({ start, end: parseFloat(mEnd[1]) });
      }
    }
  }

  for (const start of pendingStarts) {
    spans.push({ start, end: Infinity });
  }

  return spans;
}

function parseSceneDetect(stderr) {
  const re = /pts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g;
  const result = [];
  let m;
  while ((m = re.exec(stderr)) !== null) {
    result.push(parseFloat(m[1]));
  }
  return result;
}

function parseSceneCuts(stderr) {
  return parseSceneDetect(stderr).map((timestamp) => ({ timestamp }));
}

function parseSceneEvents(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    const time = line.match(/pts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    if (time) {
      current = { timestamp: Number(time[1]), score: null, type: 'hard_cut', confidence: null };
      events.push(current);
    }
    const score = line.match(/lavfi\.scene_score=([-+]?(?:\d+(?:\.\d*)?|\.\d+))/);
    if (score && current) {
      current.score = Number(score[1]);
      current.confidence = Math.max(0, Math.min(1, current.score));
    }
  }
  return events.filter((event) => Number.isFinite(event.timestamp));
}

function parseBlackIntervals(stderr) {
  const intervals = [];
  const regex = /black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)\s+black_duration:\s*([0-9.]+)/g;
  let match;
  while ((match = regex.exec(String(stderr || ''))) !== null) {
    intervals.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  }
  return intervals;
}

// Containers whose streams can usually be stream-copied straight into MP4.
const MP4_COMPATIBLE_INPUTS = new Set(['.mp4', '.m4v', '.mov']);

/**
 * Cắt đoạn [startSec, endSec) của videoPath thành một file MP4 tại outputPath.
 *
 * Stream copy (-c copy) rất nhanh nhưng chỉ dùng được khi codec nguồn hợp với
 * MP4 (H.264/AAC) — yt-dlp thường trả về WebM (VP9/Opus), nên ở đó phải
 * re-encode. Nếu copy thất bại vì lệch keyframe hoặc codec lạ thì tự động
 * re-encode để không làm hỏng cả job.
 */
async function cutClip(videoPath, startSec, endSec, outputPath, options = {}) {
  const { maxEdgePx = 0 } = options;
  const start = Math.max(0, Number(startSec) || 0);
  const duration = Number(endSec) - start;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Khoảng clip không hợp lệ: ${startSec} → ${endSec}`);
  }

  const scaleFilter = maxEdgePx > 0
    ? `scale='min(${maxEdgePx},iw)':'min(${maxEdgePx},ih)':force_original_aspect_ratio=decrease`
    : null;
  const base = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error'];
  // -ss trước -i là fast seek; đủ chính xác vì ffmpeg vẫn decode lại từ keyframe.
  const seek = ['-ss', String(start), '-i', videoPath, '-t', String(duration)];
  const canCopy = !scaleFilter &&
    MP4_COMPATIBLE_INPUTS.has(path.extname(videoPath).toLowerCase());

  const reencodeArgs = [
    ...base,
    ...seek,
    ...(scaleFilter ? ['-vf', scaleFilter] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  if (canCopy) {
    try {
      await runFfmpeg([...base, ...seek, '-c', 'copy', '-movflags', '+faststart', outputPath]);
      return outputPath;
    } catch (_err) {
      // Fall through to a re-encode; a copy failure is expected for odd codecs.
    }
  }

  await runFfmpeg(reencodeArgs);
  return outputPath;
}

/** Lấy 1 frame tại thời điểm atSec của video và ghi ra JPEG. */
async function extractPoster(videoPath, atSec, outputPath, options = {}) {
  const { width = 320 } = options;
  await runFfmpeg([
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
    '-ss', String(Math.max(0, Number(atSec) || 0)),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    outputPath,
  ]);
  return outputPath;
}

/** Exact single-frame extraction used by the canonical keyframe selector. */
async function extractFrame(videoPath, atSec, outputPath, options = {}) {
  const { maxEdgePx = 0, format = 'png' } = options;
  const filters = [];
  if (maxEdgePx > 0) {
    filters.push(`scale='min(${maxEdgePx},iw)':'min(${maxEdgePx},ih)':force_original_aspect_ratio=decrease`);
  }
  await runFfmpeg([
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error',
    '-ss', String(Math.max(0, Number(atSec) || 0)),
    '-i', videoPath,
    '-frames:v', '1',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...(format === 'jpg' ? ['-q:v', '3'] : []),
    outputPath,
  ]);
  return outputPath;
}

module.exports = {
  runFfmpeg,
  runFfprobe,
  formatTimecode,
  parseTimecode,
  parseFreezeDetect,
  parseSceneDetect,
  parseSceneCuts,
  parseSceneEvents,
  parseBlackIntervals,
  cutClip,
  extractPoster,
  extractFrame,
};
