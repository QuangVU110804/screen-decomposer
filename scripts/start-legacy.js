'use strict';
require('dotenv').config();
const fs = require('node:fs');
for (const [key, fallback] of [['FFMPEG_PATH', 'ffmpeg'], ['FFPROBE_PATH', 'ffprobe'], ['YT_DLP_PATH', 'yt-dlp']]) {
  if (process.env[key] && /[\\/]/.test(process.env[key]) && !fs.existsSync(process.env[key])) process.env[key] = fallback;
}
process.env.LEGACY_DATA_ROOT = require('node:path').resolve(__dirname, '..');
require('../legacy/video/src/server');
