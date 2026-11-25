const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../src/config');
const ffmpeg = require('../src/utils/ffmpeg');
const jobService = require('../src/services/jobService');

test('Phase 0 config exposes the canonical keys with sane types', () => {
  assert.equal(typeof config.PORT, 'number');
  assert.equal(typeof config.MAX_VIDEO_DURATION_SEC, 'number');
  assert.equal(typeof config.MAX_UPLOAD_MB, 'number');
  assert.equal(typeof config.SAMPLE_FPS, 'number');
  assert.equal(typeof config.MIN_ASSET_STILL_SEC, 'number');
  assert.equal(typeof config.PHASH_HAMMING_THRESHOLD, 'number');
  assert.equal(typeof config.MAX_CANDIDATES, 'number');
  assert.equal(typeof config.VISION_MODEL, 'string');
  assert.equal(typeof config.VISION_BATCH_SIZE, 'number');
  assert.equal(typeof config.FREEZE_NOISE_DB, 'string');
  assert.equal(typeof config.FALLBACK_TO_SCENE_CUTS, 'boolean');
  assert.equal(typeof config.SCENE_THRESHOLD, 'number');
  assert.equal(typeof config.MAX_SCENE_CANDIDATES, 'number');
  assert.equal(typeof config.VISION_MAX_RETRIES, 'number');
  assert.equal(typeof config.VISION_JPEG_QUALITY, 'number');
  assert.equal(typeof config.VISION_MAX_EDGE_PX, 'number');
  assert.equal(typeof config.MAX_VISION_IMAGE_BYTES_PER_SCENE, 'number');
  assert.equal(typeof config.MAX_VISION_PIXELS_PER_SCENE, 'number');
  assert.equal(typeof config.CLAUDE_TIMEOUT_MS, 'number');
  assert.equal(typeof config.ASSET_RETENTION_HOURS, 'number');
  assert.equal(typeof config.MAX_JOB_DISK_MB, 'number');
  assert.equal(typeof config.MAX_PIPELINE_RUNTIME_SEC, 'number');
  assert.equal(typeof config.ANTHROPIC_API_KEY, 'string');
});

test('ffmpeg helper parsers follow the Phase 0 contracts', () => {
  assert.equal(ffmpeg.formatTimecode(23.1), '00:23');
  assert.equal(ffmpeg.formatTimecode(3661.5), '61:01');
  assert.equal(ffmpeg.parseTimecode('00:23'), 23);
  assert.equal(ffmpeg.parseTimecode('00:00:23.10'), 23.1);
  assert.deepEqual(
    ffmpeg.parseFreezeDetect(
      '[freezedetect] freeze_start: 1.25 freeze_duration: 3.25 freeze_end: 4.5\n' +
      '[freezedetect] freeze_start: 8.0'
    ),
    [{ start: 1.25, end: 4.5 }, { start: 8, end: Infinity }]
  );
  assert.deepEqual(
    ffmpeg.parseSceneDetect('frame:0 pts_time:23.12\nframe:1 pts_time: 42.5'),
    [23.12, 42.5]
  );
});

test('jobService creates the canonical shape and monotonically updates updatedAt', async () => {
  const job = jobService.createJob('phase0-test', { sourceType: 'youtube' });
  assert.equal(job.status, 'pending');
  assert.deepEqual(job.candidates, []);
  assert.deepEqual(job.assets, []);
  const before = job.updatedAt;
  const updated = jobService.updateJob(job.id, { progress: 10 });
  assert.equal(updated.progress, 10);
  assert.ok(updated.updatedAt > before);
  assert.equal(jobService.updateJob('missing-job', {}), null);
});
