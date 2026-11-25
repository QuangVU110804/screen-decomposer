const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

require('dotenv').config();
const config = require('../src/config');
const vision = require('../src/services/visionService');

const imagePath = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'bars.png');

function candidates(count) {
  return Array.from({ length: count }, (_value, index) => ({
    path: imagePath,
    timestamp: index,
    timecode: `00:${String(index).padStart(2, '0')}`,
    hash: '0000000000000000',
    sharpness: 1,
  }));
}

function responseFor(batchLength, isAsset = true) {
  return {
    content: [{
      type: 'tool_use',
      name: 'report_assets',
      input: {
        assets: Array.from({ length: batchLength }, (_value, ref) => ({
          ref,
          isAsset,
          label: isAsset ? `Asset ${ref}` : '',
          description: isAsset ? `Description ${ref}.` : '',
          confidence: isAsset ? 0.8 : 0,
        })),
      },
    }],
  };
}

test('prepareImageForVision creates a bounded JPEG without enlargement', async (t) => {
  if (!fs.existsSync(imagePath)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const prepared = await vision.prepareImageForVision(imagePath);
  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.ok(prepared.bytes > 0);
  const metadata = await sharp(Buffer.from(prepared.base64, 'base64')).metadata();
  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 480);
});

test('validateVerdicts ignores malformed, out-of-range and duplicate refs', () => {
  const valid = vision.validateVerdicts([
    { ref: 0, isAsset: true, label: 'Chart', description: 'A chart.', confidence: 1.2 },
    { ref: 0, isAsset: true, label: 'Duplicate', description: 'Ignored.', confidence: 1 },
    { ref: 4, isAsset: true, label: 'Out', description: 'Ignored.', confidence: 1 },
    { ref: 1, isAsset: false, label: 'Should clear', description: 'Ignored.', confidence: -1 },
    { ref: '2', isAsset: true, label: 'Bad ref', description: 'Ignored.', confidence: 1 },
  ], 2);
  assert.deepEqual(valid, [
    { ref: 0, isAsset: true, label: 'Chart', description: 'A chart.', confidence: 1 },
    { ref: 1, isAsset: false, label: 'Should clear', description: 'Ignored.', confidence: 0 },
  ]);
});

test('classifyCandidates batches, forces report_assets and reports progress', async (t) => {
  if (!fs.existsSync(imagePath)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const calls = [];
  const client = { messages: { create: async (params) => {
    calls.push(params);
    const imageCount = params.messages[0].content.filter((block) => block.type === 'image').length;
    return responseFor(imageCount);
  } } };
  const progress = [];
  const results = await vision.classifyCandidates(candidates(7), (fraction) => progress.push(fraction), {
    client,
    batchSize: 5,
    retries: 0,
    baseMs: 0,
  });
  assert.equal(results.length, 7);
  assert.deepEqual(progress, [0.5, 1]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].tool_choice, { type: 'tool', name: 'report_assets' });
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].tools[0].name, 'report_assets');
  assert.equal(calls[0].messages[0].content.filter((block) => block.type === 'image').length, 5);
});

test('classifyCandidates retries a 429 and reuses prepared bytes', async (t) => {
  if (!fs.existsSync(imagePath)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const calls = [];
  let failedOnce = false;
  const client = { messages: { create: async (params) => {
    calls.push(params);
    const isSecondBatch = params.messages[0].content.some(
      (block) => block.type === 'text' && block.text.includes('timestamp 00:05')
    );
    if (isSecondBatch && !failedOnce) {
      failedOnce = true;
      const error = new Error('rate limited');
      error.status = 429;
      throw error;
    }
    const imageCount = params.messages[0].content.filter((block) => block.type === 'image').length;
    return responseFor(imageCount);
  } } };
  const results = await vision.classifyCandidates(candidates(7), null, {
    client,
    batchSize: 5,
    retries: 1,
    baseMs: 0,
    sleep: async () => {},
  });
  assert.equal(results.length, 7);
  assert.equal(calls.length, 3);
  const firstRetryImage = calls[1].messages[0].content.find((block) => block.type === 'image');
  const secondRetryImage = calls[2].messages[0].content.find((block) => block.type === 'image');
  assert.equal(firstRetryImage.source.data, secondRetryImage.source.data);
});

test('permanently failed batches are skipped while other results survive', async (t) => {
  if (!fs.existsSync(imagePath)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  let call = 0;
  const client = { messages: { create: async (params) => {
    call++;
    if (call === 3) {
      const error = new Error('server unavailable');
      error.status = 503;
      throw error;
    }
    const imageCount = params.messages[0].content.filter((block) => block.type === 'image').length;
    return responseFor(imageCount);
  } } };
  const results = await vision.classifyCandidates(candidates(15), null, {
    client,
    batchSize: 5,
    retries: 0,
  });
  assert.equal(call, 3);
  assert.equal(results.length, 10);
});

test('missing API key has an actionable error', async () => {
  const originalKey = config.ANTHROPIC_API_KEY;
  config.ANTHROPIC_API_KEY = ''; // exercise the missing-key path regardless of .env
  try {
    vision.resetClientForTests();
    await assert.rejects(
      vision.classifyCandidates([]),
      /Thiếu ANTHROPIC_API_KEY — không thể phân tích ảnh bằng Vision/
    );
  } finally {
    config.ANTHROPIC_API_KEY = originalKey;
  }
});
