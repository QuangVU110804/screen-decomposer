'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function number(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Cấu hình số không hợp lệ: ${value}`);
  return n;
}
function createConfig(overrides = {}) {
  return Object.freeze({
    root, dataDir: path.resolve(overrides.dataDir || process.env.IMAGE_DATA_DIR || path.join(root, 'data/images')),
    python: overrides.python || process.env.IMAGE_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    modelDir: path.join(root, 'models'), webDir: path.join(root, 'src/web'),
    port: number(overrides.port ?? process.env.IMAGE_PORT, 3000, 0, 65535), host: '127.0.0.1',
    maxBytes: 20 * 1024 * 1024, maxPixels: overrides.maxPixels || 24_000_000,
    maxAssets: 80, maxWaiting: 2, stageTimeoutMs: overrides.stageTimeoutMs || 180_000,
    maxArtifactBytes: 512 * 1024 * 1024, maxCacheBytes: 512 * 1024 * 1024, retentionMs: 24 * 60 * 60 * 1000,
    presets: Object.freeze({ fast: { edge: 768, grid: 8, batch: 8 }, balanced: { edge: 1024, grid: 12, batch: 8 } }),
  });
}
module.exports = { createConfig };
