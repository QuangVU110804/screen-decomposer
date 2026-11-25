const { spawn } = require('child_process');
const { FFPROBE_PATH } = require('../config');
const { runFfprobe } = require('./ffmpeg');

function getDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];
    const proc = spawn(FFPROBE_PATH, args);
    let out = '';
    let err = '';

    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', (c) => { err += c.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim()}`));
      const seconds = parseFloat(out.trim());
      if (Number.isNaN(seconds)) return reject(new Error('ffprobe returned invalid duration'));
      resolve(seconds);
    });

    proc.on('error', reject);
  });
}

function parseRate(value) {
  if (typeof value === 'number') return value;
  const [numerator, denominator = '1'] = String(value || '0').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : 0;
}

async function getVideoInfo(videoPath) {
  const output = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:stream_tags=rotate:side_data=rotation:format=duration',
    '-of', 'json',
    videoPath,
  ]);
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error('Video không có stream hình ảnh');
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe returned invalid duration');
  const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.[0]?.rotation ?? 0);
  const swapsDimensions = Math.abs(rotation) % 180 === 90;
  return {
    duration,
    width: Number(swapsDimensions ? stream.height : stream.width) || 0,
    height: Number(swapsDimensions ? stream.width : stream.height) || 0,
    fps: parseRate(stream.avg_frame_rate || stream.r_frame_rate),
    rotation,
  };
}

module.exports = { getDuration, getVideoInfo, parseRate };
