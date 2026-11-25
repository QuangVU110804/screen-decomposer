const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { VIDEO_DIR, YT_DLP_PATH } = require('../config');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Tải video YouTube về temp/videos/{jobId}.<ext> bằng yt-dlp.
 * onProgress nhận số % (0-100) parse từ stdout của yt-dlp.
 */
function downloadVideo(url, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    ensureDir(VIDEO_DIR);
    const outputTemplate = path.join(VIDEO_DIR, `${jobId}.%(ext)s`);

    const args = [
      url,
      '-o', outputTemplate,
      '--no-playlist',
      '--newline',
    ];

    const proc = spawn(YT_DLP_PATH, args);
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const line = chunk.toString();
      const match = line.match(/(\d+(?:\.\d+)?)%/);
      if (match && onProgress) onProgress(parseFloat(match[1]));
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      try {
        if (code !== 0) {
          return reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-500)}`));
        }
        const files = fs.readdirSync(VIDEO_DIR).filter((f) => f.startsWith(jobId));
        if (files.length === 0) return reject(new Error('Không tìm thấy file sau khi tải'));
        return resolve(path.join(VIDEO_DIR, files[0]));
      } catch (err) {
        return reject(err);
      }
    });

    proc.on('error', reject);
  });
}

module.exports = { downloadVideo };
