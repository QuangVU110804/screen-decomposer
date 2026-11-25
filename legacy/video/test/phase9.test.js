const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runFfprobe } = require('../src/utils/ffmpeg');

require('dotenv').config();
const config = require('../src/config');
const clipService = require('../src/services/clipService');

const FIXTURE = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'slideshow.mp4');

async function clean(jobId) {
  await fs.promises.rm(path.join(config.CANDIDATE_DIR, jobId), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
}

test('detectSceneSegments returns ordered non-empty segments for a slideshow', async (t) => {
  if (!fs.existsSync(FIXTURE)) { t.skip('fixtures missing'); return; }
  const segments = await clipService.detectSceneSegments(FIXTURE, 43);
  assert.ok(Array.isArray(segments));
  assert.ok(segments.length >= 1);
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].start >= segments[i - 1].end - 0.01, 'segments must be chronological');
  }
  segments.forEach((segment) => {
    assert.ok(Number.isFinite(segment.start));
    assert.ok(Number.isFinite(segment.end));
    assert.ok(segment.end > segment.start);
  });
});

test('extractSceneClips writes playable mp4 clips + posters', async (t) => {
  if (!fs.existsSync(FIXTURE)) { t.skip('fixtures missing'); return; }
  const jobId = `phase9-scene-${Date.now()}`;
  try {
    const clips = await clipService.extractSceneClips(jobId, FIXTURE, 43, null, {
      maxSegments: 3,
      minSceneClipSec: 0.3,
    });
    assert.ok(clips.length >= 1);
    clips.forEach((clip) => {
      assert.ok(fs.existsSync(clip.clipPath), 'clip file written: ' + clip.clipPath);
      assert.ok(clip.clipPath.endsWith('.mp4'));
      assert.ok(clip.duration > 0);
      assert.ok(clip.timecode);
    });
    // Verify the first clip is parseable video.
    const probe = await runFfprobe(['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', clips[0].clipPath]);
    const types = JSON.parse(probe).streams.map((s) => s.codec_type);
    assert.ok(types.includes('video'), 'clip has a video stream');
  } finally {
    await clean(jobId);
  }
});

test('attachAssetClips centers a clip on each confirmed asset', async (t) => {
  if (!fs.existsSync(FIXTURE)) { t.skip('fixtures missing'); return; }
  const jobId = `phase9-asset-${Date.now()}`;
  const assets = [
    { timestamp: 5, label: 'A' },
    { timestamp: 20, label: 'B' },
  ];
  try {
    const withClips = await clipService.attachAssetClips(jobId, FIXTURE, assets, 43, null, {
      clipPaddingSec: 1.5,
    });
    assert.equal(withClips.length, 2);
    assert.ok(withClips[0].clipPath && fs.existsSync(withClips[0].clipPath));
    assert.ok(withClips[1].clipPath && fs.existsSync(withClips[1].clipPath));
    assert.equal(withClips[0].clipStart, 5 - 1.5);
    assert.ok(withClips[0].clipDuration >= 3 - 0.1 && withClips[0].clipDuration <= 3.1);
    assert.equal(withClips[0].label, 'A');
  } finally {
    await clean(jobId);
  }
});

test('attachAssetClips spares an asset when the clip cut fails', async (t) => {
  if (!fs.existsSync(FIXTURE)) { t.skip('fixtures missing'); return; }
  const jobId = `phase9-missing-${Date.now()}`;
  const assets = [{ timestamp: 5, label: 'A' }];
  try {
    const result = await clipService.attachAssetClips(jobId, path.join(config.VIDEO_DIR, 'does-not-exist.mp4'), assets, 10, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].clipPath, undefined, 'no clip created for a failing video');
    assert.equal(result[0].label, 'A');
  } finally {
    await clean(jobId);
  }
});
