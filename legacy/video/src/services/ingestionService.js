const fs = require('fs');
const path = require('path');

const config = require('../config');
const { getDuration } = require('../utils/videoInfo');

const ALLOWED_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi']);

/**
 * Normalize the input forms that are commonly pasted from YouTube.
 * Anything that is already a full URL is returned trimmed and otherwise
 * untouched; yt-dlp is responsible for validating the URL itself.
 */
function resolveYoutube(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('URL YouTube không hợp lệ');
  }

  const value = input.trim();
  const embedMatch = value.match(/embed\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
  if (embedMatch) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;

  const shortMatch = value.match(/(?:^|\/\/)(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
  if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`;

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return `https://www.youtube.com/watch?v=${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error('URL YouTube không hợp lệ');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('URL YouTube không hợp lệ');
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const allowedHosts = new Set([
    'youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'youtu.be',
  ]);
  if (!allowedHosts.has(host)) {
    throw new Error('Chỉ chấp nhận URL thuộc YouTube');
  }
  return value;
}

async function guardDuration(videoPath) {
  const duration = await getDuration(videoPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Không đọc được thời lượng video (file hỏng / sai định dạng)');
  }
  if (duration > config.MAX_VIDEO_DURATION_SEC) {
    throw new Error(
      `Video dài ${Math.round(duration)}s, vượt giới hạn ${config.MAX_VIDEO_DURATION_SEC}s (MAX_VIDEO_DURATION_SEC)`
    );
  }
  return duration;
}

async function unlinkIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function moveFile(source, destination) {
  try {
    await fs.promises.rename(source, destination);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.promises.copyFile(source, destination);
    await fs.promises.unlink(source);
  }
}

async function acceptUpload(jobId, file) {
  if (!file) {
    throw new Error('Không nhận được file (đúng tên field là "file"?)');
  }

  const originalFilename = file.originalname || '';
  const ext = (path.extname(originalFilename).slice(1) || '').toLowerCase();
  const sourcePath = file.path;
  let destinationPath = null;

  try {
    if (!ALLOWED_EXT.has(ext)) {
      throw new Error(
        `Định dạng không được hỗ trợ: .${ext || '?'} (cho phép: mp4, mov, mkv, webm, avi)`
      );
    }

    if (Number.isFinite(file.size) && file.size > config.MAX_UPLOAD_MB * 1024 * 1024) {
      throw new Error(`Vượt quá ${config.MAX_UPLOAD_MB}MB`);
    }

    config.ensureDir(config.VIDEO_DIR);
    destinationPath = path.join(config.VIDEO_DIR, `${jobId}.${ext}`);
    await moveFile(sourcePath, destinationPath);

    // Extension and MIME are only an initial filter; ffprobe is the proof that
    // the renamed file is a decodable video and also supplies its duration.
    const duration = await guardDuration(destinationPath);
    return { videoPath: destinationPath, duration, originalFilename };
  } catch (err) {
    // Covers invalid extension, size, move failure and ffprobe failure. The
    // route also performs a best-effort cleanup, but keeping it here makes the
    // service safe for direct callers and prevents .part leaks.
    await unlinkIfExists(sourcePath).catch(() => {});
    if (destinationPath) await unlinkIfExists(destinationPath).catch(() => {});
    throw err;
  }
}

module.exports = { ALLOWED_EXT, resolveYoutube, guardDuration, acceptUpload };
