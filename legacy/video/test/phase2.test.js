const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('dotenv').config();
const config = require('../src/config');
const { dhashFromFile, hamming } = require('../src/utils/hash');
const { sharpnessFromFile } = require('../src/utils/sharpness');
const { getDuration } = require('../src/utils/videoInfo');
const candidateService = require('../src/services/candidateService');
const keyframeSelection = require('../src/services/keyframeSelectionService');
const { createJob, getJob } = require('../src/services/jobService');

const fixtureDir = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2');

function fixture(name) {
  return path.join(fixtureDir, name);
}

function hasFixture(name) {
  return fs.existsSync(fixture(name));
}

test('dHash stays stable for brightness and resize changes', async (t) => {
  if (!hasFixture('bars.png')) {
    t.skip('Phase 2 image fixtures are not available');
    return;
  }
  const original = await dhashFromFile(fixture('bars.png'));
  const bright = await dhashFromFile(fixture('bars_bright.png'));
  const resized = await dhashFromFile(fixture('bars_resized.png'));
  const unrelated = await dhashFromFile(fixture('red.png'));
  assert.match(original, /^[0-9a-f]{16}$/);
  assert.ok(hamming(original, bright) <= 3);
  assert.ok(hamming(original, resized) <= 3);
  assert.ok(hamming(original, unrelated) >= 20);
  assert.equal(hamming(original, original), 0);
  const textStructure = await keyframeSelection.textStructureHash(fixture('bars.png'));
  const brightTextStructure = await keyframeSelection.textStructureHash(fixture('bars_bright.png'));
  const flatTextStructure = await keyframeSelection.textStructureHash(fixture('flat.png'));
  assert.match(textStructure, /^[0-9a-f]{64}$/);
  assert.ok(hamming(textStructure, brightTextStructure) <= 3);
  assert.ok(hamming(textStructure, flatTextStructure) >= 20);
});

test('sharpness ranks sharp frames above blurred frames and flat images near zero', async (t) => {
  if (!hasFixture('sharp_a.png')) {
    t.skip('Phase 2 image fixtures are not available');
    return;
  }
  const sharp = await sharpnessFromFile(fixture('sharp_a.png'));
  const blurred = await sharpnessFromFile(fixture('blur_a.png'));
  const flat = await sharpnessFromFile(fixture('flat.png'));
  assert.ok(sharp > blurred * 5, `${sharp} is not 5x ${blurred}`);
  assert.ok(flat < 0.001, `flat score was ${flat}`);
});

test('corrupt image rejects without hanging', async () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const corrupt = fixture('phase2-corrupt.png');
  fs.writeFileSync(corrupt, 'not a PNG');
  try {
    await assert.rejects(dhashFromFile(corrupt));
  } finally {
    fs.unlinkSync(corrupt);
  }
});

test('grouping compares to the representative and prevents hash chaining drift', () => {
  const frame = (index, hash, sharpness = 1) => ({
    index,
    timestamp: index,
    hash,
    sharpness,
    chroma: [0.33, 0.33, 0.34],
    span: { start: index, end: index + 1 },
  });
  const groups = candidateService.groupMeasuredFrames([
    frame(1, '0000000000000000'),
    frame(2, '0000000000000007'), // distance 3 from A
    frame(3, '000000000000003f'), // distance 6 from A, distance 3 from B
  ], 5);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.members.length), [2, 1]);
});

test('sampleFrames uses sorted 1-based filenames with zero-based timestamps', async (t) => {
  const source = path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4');
  if (!fs.existsSync(source)) {
    t.skip('sample.mp4 fixture is not available');
    return;
  }
  const jobId = `phase2-sample-${Date.now()}`;
  const doubleRateJobId = `${jobId}-2fps`;
  try {
    const frames = await candidateService.sampleFrames(source, jobId, null, { sampleFps: 1 });
    assert.equal(frames.length, 5);
    assert.equal(frames[3].timestamp, 3);
    assert.equal(frames[0].index, 1);
    const doubleRate = await candidateService.sampleFrames(source, doubleRateJobId, null, { sampleFps: 2 });
    assert.equal(doubleRate.length, 10);
    assert.equal(doubleRate[3].timestamp, 1.5);
  } finally {
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, doubleRateJobId), { recursive: true, force: true });
  }
});

test('freezedetect finds slideshow holds but not continuous motion', async (t) => {
  if (!hasFixture('slideshow.mp4') || !fs.existsSync(path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4'))) {
    t.skip('Phase 2 video fixtures are not available');
    return;
  }
  const slideshowSpans = await candidateService.detectStillSpans(fixture('slideshow.mp4'));
  assert.equal(slideshowSpans.length, 8);
  const movingSpans = await candidateService.detectStillSpans(
    path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4')
  );
  assert.deepEqual(movingSpans, []);
  const strictSpans = await candidateService.detectStillSpans(fixture('slideshow.mp4'), { minStillSec: 10 });
  assert.deepEqual(strictSpans, []);
});

test('slideshow produces exactly eight distinct freeze candidates and is idempotent', async (t) => {
  if (!hasFixture('slideshow.mp4')) {
    t.skip('slideshow fixture is not available');
    return;
  }
  const videoPath = fixture('slideshow.mp4');
  const duration = await getDuration(videoPath);
  const jobId = `phase2-slideshow-${Date.now()}`;
  const job = createJob(jobId, { duration });
  try {
    const first = await candidateService.findCandidates(job, videoPath);
    assert.equal(first.length, 8);
    assert.deepEqual(first.map((candidate) => candidate.timestamp), [6, 10, 14, 18, 22, 26, 30, 34]);
    assert.ok(first.every((candidate) => candidate.groupSize > 1));
    assert.ok(first.every((candidate) => fs.existsSync(candidate.path)));
    assert.equal(getJob(jobId).detectionMode, 'freeze');

    const second = await candidateService.findCandidates(job, videoPath);
    assert.equal(second.length, 8);
    const files = (await fs.promises.readdir(path.join(config.CANDIDATE_DIR, jobId, 'frames')))
      .filter((name) => /^f_\d{5}\.png$/.test(name));
    assert.equal(files.length, 43);
  } finally {
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, jobId), { recursive: true, force: true });
  }
});

test('scene fallback records its mode and can be disabled', async (t) => {
  if (!hasFixture('kenburns.mp4')) {
    t.skip('kenburns fixture is not available');
    return;
  }
  const videoPath = fixture('kenburns.mp4');
  const duration = await getDuration(videoPath);
  const enabledId = `phase2-fallback-on-${Date.now()}`;
  const disabledId = `phase2-fallback-off-${Date.now()}`;
  const enabledJob = createJob(enabledId, { duration });
  const disabledJob = createJob(disabledId, { duration });
  try {
    const enabled = await candidateService.findCandidates(enabledJob, videoPath, null, {
      fallbackToSceneCuts: true,
    });
    const disabled = await candidateService.findCandidates(disabledJob, videoPath, null, {
      fallbackToSceneCuts: false,
    });
    assert.ok(enabled.length >= 1);
    assert.equal(getJob(enabledId).detectionMode, 'scene_fallback');
    assert.equal(disabled.length, 0);
    assert.equal(getJob(disabledId).detectionMode, 'freeze');
  } finally {
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, enabledId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, disabledId), { recursive: true, force: true });
  }
});
