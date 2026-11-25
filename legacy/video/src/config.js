const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.LEGACY_DATA_ROOT || path.join(__dirname, '..');

const TEMP_DIR = path.join(ROOT, 'temp');
const VIDEO_DIR = path.join(ROOT, 'temp', 'videos');
const CANDIDATE_DIR = path.join(ROOT, 'temp', 'candidates');
const ASSET_DIR = path.join(ROOT, 'temp', 'assets');
const JOB_DIR = path.join(ROOT, 'temp', 'jobs');
const UPLOAD_TMP_DIR = path.join(ROOT, 'temp', 'uploads');

const PORT = parseInt(process.env.PORT || '3000', 10);

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

const MAX_VIDEO_DURATION_SEC = parseInt(process.env.MAX_VIDEO_DURATION_SEC || '600', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '500', 10);
const SAMPLE_FPS = parseFloat(process.env.SAMPLE_FPS || '1');
const MIN_ASSET_STILL_SEC = parseFloat(process.env.MIN_ASSET_STILL_SEC || '0.8');
const PHASH_HAMMING_THRESHOLD = parseInt(process.env.PHASH_HAMMING_THRESHOLD || '10', 10);
const MAX_CANDIDATES = parseInt(process.env.MAX_CANDIDATES || '60', 10);
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-5';
const VISION_BATCH_SIZE = parseInt(process.env.VISION_BATCH_SIZE || '5', 10);
const FREEZE_NOISE_DB = process.env.FREEZE_NOISE_DB || '-50dB';
const FALLBACK_TO_SCENE_CUTS = parseBoolean(process.env.FALLBACK_TO_SCENE_CUTS, true);
const SCENE_THRESHOLD = parseFloat(process.env.SCENE_THRESHOLD || '0.3');
const MAX_SCENE_CANDIDATES = parseInt(process.env.MAX_SCENE_CANDIDATES || '25', 10);
const VISION_MAX_RETRIES = parseInt(process.env.VISION_MAX_RETRIES || '3', 10);
const VISION_JPEG_QUALITY = parseInt(process.env.VISION_JPEG_QUALITY || '70', 10);
const VISION_MAX_EDGE_PX = parseInt(process.env.VISION_MAX_EDGE_PX || '1024', 10);
const MAX_VISION_IMAGE_BYTES_PER_SCENE = parseInt(
  process.env.MAX_VISION_IMAGE_BYTES_PER_SCENE || String(12 * 1024 * 1024),
  10
);
const MAX_VISION_PIXELS_PER_SCENE = parseInt(
  process.env.MAX_VISION_PIXELS_PER_SCENE || String(8 * 1024 * 1024),
  10
);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '60000', 10);
const ASSET_RETENTION_HOURS = parseInt(process.env.ASSET_RETENTION_HOURS || '24', 10);
const MAX_JOB_DISK_MB = parseInt(process.env.MAX_JOB_DISK_MB || '2048', 10);
const MAX_PIPELINE_RUNTIME_SEC = parseInt(process.env.MAX_PIPELINE_RUNTIME_SEC || '1800', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Scene decomposer v2. These limits are analysis budgets; unlike the legacy
// MAX_SCENE_CANDIDATES setting they never remove scenes from the partition.
const MIN_SCENE_DURATION_SEC = parseFloat(process.env.MIN_SCENE_DURATION_SEC || '0.45');
const MAX_SCENE_DURATION_SEC = parseFloat(process.env.MAX_SCENE_DURATION_SEC || '30');
const KEYFRAMES_PER_SCENE = parseInt(process.env.KEYFRAMES_PER_SCENE || '5', 10);
const MAX_KEYFRAMES_PER_SCENE = parseInt(process.env.MAX_KEYFRAMES_PER_SCENE || '8', 10);
const MAX_TOTAL_KEYFRAMES = parseInt(process.env.MAX_TOTAL_KEYFRAMES || '120', 10);
const MAX_SCENES = parseInt(process.env.MAX_SCENES || '300', 10);
const ENABLE_SEGMENTATION = parseBoolean(process.env.ENABLE_SEGMENTATION, true);
const SEGMENTER_ENDPOINT = process.env.SEGMENTER_ENDPOINT || '';
const SEGMENTER_API_KEY = process.env.SEGMENTER_API_KEY || '';
const SEGMENTER_PROVIDER_VERSION = process.env.SEGMENTER_PROVIDER_VERSION || 'unknown';
const SEGMENTER_TIMEOUT_MS = parseInt(process.env.SEGMENTER_TIMEOUT_MS || '90000', 10);
const SEGMENTATION_LOCAL_FALLBACK = parseBoolean(process.env.SEGMENTATION_LOCAL_FALLBACK, true);
const MAX_SEGMENTATION_CALLS = parseInt(process.env.MAX_SEGMENTATION_CALLS || '80', 10);
const ENABLE_BACKGROUND_RECOVERY = parseBoolean(process.env.ENABLE_BACKGROUND_RECOVERY, false);
const INPAINTER_ENDPOINT = process.env.INPAINTER_ENDPOINT || '';
const INPAINTER_API_KEY = process.env.INPAINTER_API_KEY || '';
const INPAINTER_PROVIDER_VERSION = process.env.INPAINTER_PROVIDER_VERSION || 'unknown';
const INPAINTER_TIMEOUT_MS = parseInt(process.env.INPAINTER_TIMEOUT_MS || '120000', 10);
const INPAINTER_LOCAL_FALLBACK = parseBoolean(process.env.INPAINTER_LOCAL_FALLBACK, true);
const MAX_INPAINT_AREA_RATIO = parseFloat(process.env.MAX_INPAINT_AREA_RATIO || '0.35');
const DIRECT_CROP_PADDING = parseFloat(process.env.DIRECT_CROP_PADDING || '0.025');
const ASSET_MIN_QUALITY = parseFloat(process.env.ASSET_MIN_QUALITY || '0.48');
const ASSET_REVIEW_QUALITY = parseFloat(process.env.ASSET_REVIEW_QUALITY || '0.68');
const ASSET_DEDUPE_HAMMING = parseInt(process.env.ASSET_DEDUPE_HAMMING || '5', 10);

// Video clip extraction (Phase 9)
const CLIP_PADDING_SEC = parseFloat(process.env.CLIP_PADDING_SEC || '2'); // each side of an asset clip
const MIN_SCENE_CLIP_SEC = parseFloat(process.env.MIN_SCENE_CLIP_SEC || '1'); // drop shorter scene segments
const CLIP_MAX_EDGE_PX = parseInt(process.env.CLIP_MAX_EDGE_PX || '0', 10); // 0 = keep original size

// Optional API-key auth for write endpoints. When empty, auth is disabled
// (local/dev). Set to a non-empty value to require X-API-Key on POST routes.
const API_KEY = process.env.API_KEY || '';

// HTTP rate limiting for POST (extract/upload) endpoints.
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);

const CONFIG_REGISTRY = Object.freeze({
  PORT: { public: false, secret: false },
  YT_DLP_PATH: { public: false, secret: false },
  FFMPEG_PATH: { public: false, secret: false },
  FFPROBE_PATH: { public: false, secret: false },
  MAX_VIDEO_DURATION_SEC: { public: true, secret: false },
  MAX_UPLOAD_MB: { public: true, secret: false },
  SAMPLE_FPS: { public: false, secret: false, legacy: true },
  MIN_ASSET_STILL_SEC: { public: false, secret: false, legacy: true },
  PHASH_HAMMING_THRESHOLD: { public: false, secret: false, legacy: true },
  MAX_CANDIDATES: { public: false, secret: false, legacy: true },
  FREEZE_NOISE_DB: { public: false, secret: false, legacy: true },
  FALLBACK_TO_SCENE_CUTS: { public: false, secret: false, legacy: true },
  SCENE_THRESHOLD: { public: false, secret: false },
  MAX_SCENE_CANDIDATES: { public: false, secret: false, legacy: true },
  MIN_SCENE_DURATION_SEC: { public: true, secret: false },
  MAX_SCENE_DURATION_SEC: { public: true, secret: false },
  MAX_SCENES: { public: true, secret: false },
  KEYFRAMES_PER_SCENE: { public: true, secret: false },
  MAX_KEYFRAMES_PER_SCENE: { public: true, secret: false },
  MAX_TOTAL_KEYFRAMES: { public: true, secret: false },
  VISION_MODEL: { public: false, secret: false },
  VISION_BATCH_SIZE: { public: false, secret: false, legacy: true },
  VISION_MAX_RETRIES: { public: false, secret: false },
  VISION_JPEG_QUALITY: { public: false, secret: false },
  VISION_MAX_EDGE_PX: { public: false, secret: false },
  MAX_VISION_IMAGE_BYTES_PER_SCENE: { public: false, secret: false },
  MAX_VISION_PIXELS_PER_SCENE: { public: false, secret: false },
  CLAUDE_TIMEOUT_MS: { public: false, secret: false },
  MAX_JOB_DISK_MB: { public: true, secret: false },
  MAX_PIPELINE_RUNTIME_SEC: { public: true, secret: false },
  ANTHROPIC_API_KEY: { public: false, secret: true },
  ENABLE_SEGMENTATION: { public: true, secret: false },
  SEGMENTER_ENDPOINT: { public: false, secret: false },
  SEGMENTER_API_KEY: { public: false, secret: true },
  SEGMENTER_PROVIDER_VERSION: { public: false, secret: false },
  SEGMENTER_TIMEOUT_MS: { public: false, secret: false },
  SEGMENTATION_LOCAL_FALLBACK: { public: false, secret: false },
  MAX_SEGMENTATION_CALLS: { public: true, secret: false },
  ENABLE_BACKGROUND_RECOVERY: { public: true, secret: false },
  INPAINTER_ENDPOINT: { public: false, secret: false },
  INPAINTER_API_KEY: { public: false, secret: true },
  INPAINTER_PROVIDER_VERSION: { public: false, secret: false },
  INPAINTER_TIMEOUT_MS: { public: false, secret: false },
  INPAINTER_LOCAL_FALLBACK: { public: false, secret: false },
  MAX_INPAINT_AREA_RATIO: { public: true, secret: false },
  DIRECT_CROP_PADDING: { public: false, secret: false },
  ASSET_MIN_QUALITY: { public: true, secret: false },
  ASSET_REVIEW_QUALITY: { public: true, secret: false },
  ASSET_DEDUPE_HAMMING: { public: false, secret: false },
  CLIP_PADDING_SEC: { public: false, secret: false, legacy: true },
  MIN_SCENE_CLIP_SEC: { public: false, secret: false, legacy: true },
  CLIP_MAX_EDGE_PX: { public: false, secret: false, legacy: true },
  ASSET_RETENTION_HOURS: { public: true, secret: false },
  API_KEY: { public: false, secret: true },
  RATE_LIMIT_WINDOW_MS: { public: false, secret: false },
  RATE_LIMIT_MAX: { public: false, secret: false },
});

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (/^(true|1|yes|on)$/i.test(value)) return true;
  if (/^(false|0|no|off)$/i.test(value)) return false;
  return value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function assertBinaries() {
  const bins = [
    { name: 'ffmpeg', bin: FFMPEG_PATH },
    { name: 'ffprobe', bin: FFPROBE_PATH },
    { name: 'yt-dlp', bin: YT_DLP_PATH },
  ];
  for (const { name, bin } of bins) {
    const args = name === 'yt-dlp' ? ['--version'] : ['-version'];
    let result;
    try {
      result = spawnSync(bin, args, { timeout: 5000, windowsHide: true });
    } catch (e) {
      throw new Error(
        `Binary not found: ${name} (${bin}): ${e.message}. See README for install instructions.`
      );
    }
    if (result.error) {
      if (result.error.code === 'ENOENT') {
        throw new Error(
          `Binary not found: ${name} (${bin}) — not in PATH or file does not exist. See README for install instructions.`
        );
      }
      throw new Error(
        `Failed to run ${name} (${bin}): ${result.error.message}. See README for install instructions.`
      );
    }
    if (result.status !== 0) {
      const detail = result.signal ? ` (signal ${result.signal})` : ` (exit code ${result.status})`;
      throw new Error(
        `Binary check failed: ${name} (${bin})${detail}. See README for install instructions.`
      );
    }
  }
}

function validateConfig({ allowMissingApiKey = true } = {}) {
  const errors = [];

  function checkInt(name, value, { min, max } = {}) {
    if (!Number.isInteger(value) || Number.isNaN(value)) {
      errors.push(`${name} must be an integer, got: ${value}`);
      return;
    }
    if (min !== undefined && value < min) errors.push(`${name} must be >= ${min}, got: ${value}`);
    if (max !== undefined && value > max) errors.push(`${name} must be <= ${max}, got: ${value}`);
  }

  function checkFloat(name, value, { min, max } = {}) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${name} must be a number, got: ${value}`);
      return;
    }
    if (min !== undefined && value < min) errors.push(`${name} must be >= ${min}, got: ${value}`);
    if (max !== undefined && value > max) errors.push(`${name} must be <= ${max}, got: ${value}`);
  }

  checkInt('PORT', PORT, { min: 1, max: 65535 });
  checkInt('MAX_VIDEO_DURATION_SEC', MAX_VIDEO_DURATION_SEC, { min: 1 });
  checkInt('MAX_UPLOAD_MB', MAX_UPLOAD_MB, { min: 1 });
  checkFloat('SAMPLE_FPS', SAMPLE_FPS, { min: 0.01 });
  checkFloat('MIN_ASSET_STILL_SEC', MIN_ASSET_STILL_SEC, { min: 0 });
  checkInt('PHASH_HAMMING_THRESHOLD', PHASH_HAMMING_THRESHOLD, { min: 0, max: 64 });
  checkInt('MAX_CANDIDATES', MAX_CANDIDATES, { min: 1 });
  checkInt('VISION_BATCH_SIZE', VISION_BATCH_SIZE, { min: 1 });
  checkInt('MAX_SCENE_CANDIDATES', MAX_SCENE_CANDIDATES, { min: 1 });
  checkInt('VISION_MAX_RETRIES', VISION_MAX_RETRIES, { min: 0 });
  checkInt('VISION_JPEG_QUALITY', VISION_JPEG_QUALITY, { min: 1, max: 100 });
  checkInt('VISION_MAX_EDGE_PX', VISION_MAX_EDGE_PX, { min: 1 });
  checkInt('MAX_VISION_IMAGE_BYTES_PER_SCENE', MAX_VISION_IMAGE_BYTES_PER_SCENE, { min: 1 });
  checkInt('MAX_VISION_PIXELS_PER_SCENE', MAX_VISION_PIXELS_PER_SCENE, { min: 1 });
  checkInt('CLAUDE_TIMEOUT_MS', CLAUDE_TIMEOUT_MS, { min: 1000 });
  checkInt('ASSET_RETENTION_HOURS', ASSET_RETENTION_HOURS, { min: 1 });
  checkInt('MAX_JOB_DISK_MB', MAX_JOB_DISK_MB, { min: 1 });
  checkInt('MAX_PIPELINE_RUNTIME_SEC', MAX_PIPELINE_RUNTIME_SEC, { min: 1 });
  checkFloat('SCENE_THRESHOLD', SCENE_THRESHOLD, { min: 0, max: 1 });
  checkInt('RATE_LIMIT_WINDOW_MS', RATE_LIMIT_WINDOW_MS, { min: 1000 });
  checkInt('RATE_LIMIT_MAX', RATE_LIMIT_MAX, { min: 1 });
  checkFloat('CLIP_PADDING_SEC', CLIP_PADDING_SEC, { min: 0 });
  checkFloat('MIN_SCENE_CLIP_SEC', MIN_SCENE_CLIP_SEC, { min: 0 });
  checkInt('CLIP_MAX_EDGE_PX', CLIP_MAX_EDGE_PX, { min: 0 });
  checkFloat('MIN_SCENE_DURATION_SEC', MIN_SCENE_DURATION_SEC, { min: 0.05 });
  checkFloat('MAX_SCENE_DURATION_SEC', MAX_SCENE_DURATION_SEC, { min: MIN_SCENE_DURATION_SEC });
  checkInt('KEYFRAMES_PER_SCENE', KEYFRAMES_PER_SCENE, { min: 1, max: 8 });
  checkInt('MAX_KEYFRAMES_PER_SCENE', MAX_KEYFRAMES_PER_SCENE, { min: KEYFRAMES_PER_SCENE, max: 12 });
  checkInt('MAX_TOTAL_KEYFRAMES', MAX_TOTAL_KEYFRAMES, { min: 1 });
  checkInt('MAX_SCENES', MAX_SCENES, { min: 1 });
  checkInt('SEGMENTER_TIMEOUT_MS', SEGMENTER_TIMEOUT_MS, { min: 1000 });
  checkInt('MAX_SEGMENTATION_CALLS', MAX_SEGMENTATION_CALLS, { min: 0 });
  checkInt('INPAINTER_TIMEOUT_MS', INPAINTER_TIMEOUT_MS, { min: 1000 });
  checkFloat('MAX_INPAINT_AREA_RATIO', MAX_INPAINT_AREA_RATIO, { min: 0, max: 1 });
  checkFloat('DIRECT_CROP_PADDING', DIRECT_CROP_PADDING, { min: 0, max: 0.25 });
  checkFloat('ASSET_MIN_QUALITY', ASSET_MIN_QUALITY, { min: 0, max: 1 });
  checkFloat('ASSET_REVIEW_QUALITY', ASSET_REVIEW_QUALITY, { min: ASSET_MIN_QUALITY, max: 1 });
  checkInt('ASSET_DEDUPE_HAMMING', ASSET_DEDUPE_HAMMING, { min: 0, max: 64 });

  if (typeof ENABLE_SEGMENTATION !== 'boolean') errors.push('ENABLE_SEGMENTATION must be a boolean');
  if (typeof SEGMENTATION_LOCAL_FALLBACK !== 'boolean') errors.push('SEGMENTATION_LOCAL_FALLBACK must be a boolean');
  if (typeof ENABLE_BACKGROUND_RECOVERY !== 'boolean') errors.push('ENABLE_BACKGROUND_RECOVERY must be a boolean');
  if (typeof INPAINTER_LOCAL_FALLBACK !== 'boolean') errors.push('INPAINTER_LOCAL_FALLBACK must be a boolean');

  if (typeof FREEZE_NOISE_DB !== 'string' || FREEZE_NOISE_DB.length === 0) {
    errors.push('FREEZE_NOISE_DB must be a non-empty string');
  }
  if (typeof FALLBACK_TO_SCENE_CUTS !== 'boolean') {
    errors.push('FALLBACK_TO_SCENE_CUTS must be a boolean');
  }

  if (typeof VISION_MODEL !== 'string' || VISION_MODEL.length === 0) {
    errors.push('VISION_MODEL must be a non-empty string');
  }
  if (typeof SEGMENTER_PROVIDER_VERSION !== 'string' || SEGMENTER_PROVIDER_VERSION.length === 0) {
    errors.push('SEGMENTER_PROVIDER_VERSION must be a non-empty string');
  }
  if (typeof INPAINTER_PROVIDER_VERSION !== 'string' || INPAINTER_PROVIDER_VERSION.length === 0) {
    errors.push('INPAINTER_PROVIDER_VERSION must be a non-empty string');
  }

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n  - ' + errors.join('\n  - '));
  }

  if (!ANTHROPIC_API_KEY) {
    const msg = 'ANTHROPIC_API_KEY is not set — Vision features (Phase 3+) will not work.';
    if (allowMissingApiKey) {
      console.warn('[config] WARN: ' + msg);
    } else {
      throw new Error(msg);
    }
  }
}

function publicConfig() {
  return {
    maxUploadMb: module.exports.MAX_UPLOAD_MB,
    maxDurationSec: module.exports.MAX_VIDEO_DURATION_SEC,
    allowedExtensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'],
    authRequired: Boolean(module.exports.API_KEY),
    schemaVersion: 2,
    keyframesPerScene: module.exports.KEYFRAMES_PER_SCENE,
    maxKeyframesPerScene: module.exports.MAX_KEYFRAMES_PER_SCENE,
    maxScenes: module.exports.MAX_SCENES,
    maxJobDiskMb: module.exports.MAX_JOB_DISK_MB,
    maxPipelineRuntimeSec: module.exports.MAX_PIPELINE_RUNTIME_SEC,
    segmentationEnabled: Boolean(module.exports.ENABLE_SEGMENTATION),
    backgroundRecoveryEnabled: Boolean(module.exports.ENABLE_BACKGROUND_RECOVERY),
    assetMinQuality: module.exports.ASSET_MIN_QUALITY,
    assetReviewQuality: module.exports.ASSET_REVIEW_QUALITY,
    retentionHours: module.exports.ASSET_RETENTION_HOURS,
  };
}

module.exports = {
  TEMP_DIR,
  VIDEO_DIR,
  CANDIDATE_DIR,
  ASSET_DIR,
  JOB_DIR,
  UPLOAD_TMP_DIR,
  PORT,
  YT_DLP_PATH,
  FFMPEG_PATH,
  FFPROBE_PATH,
  MAX_VIDEO_DURATION_SEC,
  MAX_UPLOAD_MB,
  SAMPLE_FPS,
  MIN_ASSET_STILL_SEC,
  PHASH_HAMMING_THRESHOLD,
  MAX_CANDIDATES,
  VISION_MODEL,
  VISION_BATCH_SIZE,
  FREEZE_NOISE_DB,
  FALLBACK_TO_SCENE_CUTS,
  SCENE_THRESHOLD,
  MAX_SCENE_CANDIDATES,
  VISION_MAX_RETRIES,
  VISION_JPEG_QUALITY,
  VISION_MAX_EDGE_PX,
  MAX_VISION_IMAGE_BYTES_PER_SCENE,
  MAX_VISION_PIXELS_PER_SCENE,
  CLAUDE_TIMEOUT_MS,
  ASSET_RETENTION_HOURS,
  MAX_JOB_DISK_MB,
  MAX_PIPELINE_RUNTIME_SEC,
  ANTHROPIC_API_KEY,
  MIN_SCENE_DURATION_SEC,
  MAX_SCENE_DURATION_SEC,
  KEYFRAMES_PER_SCENE,
  MAX_KEYFRAMES_PER_SCENE,
  MAX_TOTAL_KEYFRAMES,
  MAX_SCENES,
  ENABLE_SEGMENTATION,
  SEGMENTER_ENDPOINT,
  SEGMENTER_API_KEY,
  SEGMENTER_PROVIDER_VERSION,
  SEGMENTER_TIMEOUT_MS,
  SEGMENTATION_LOCAL_FALLBACK,
  MAX_SEGMENTATION_CALLS,
  ENABLE_BACKGROUND_RECOVERY,
  INPAINTER_ENDPOINT,
  INPAINTER_API_KEY,
  INPAINTER_PROVIDER_VERSION,
  INPAINTER_TIMEOUT_MS,
  INPAINTER_LOCAL_FALLBACK,
  MAX_INPAINT_AREA_RATIO,
  DIRECT_CROP_PADDING,
  ASSET_MIN_QUALITY,
  ASSET_REVIEW_QUALITY,
  ASSET_DEDUPE_HAMMING,
  CLIP_PADDING_SEC,
  MIN_SCENE_CLIP_SEC,
  CLIP_MAX_EDGE_PX,
  API_KEY,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  CONFIG_REGISTRY,
  publicConfig,
  ensureDir,
  assertBinaries,
  validateConfig,
};
