'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const config = require('../src/config');
const acceptance = require('../scripts/summarize-editor-acceptance');

test('editor acceptance recognizes only explicit reviewed statuses', () => {
  assert.equal(acceptance.isReviewedStatus('human-editor-reviewed'), true);
  assert.equal(acceptance.isReviewedStatus('APPROVED'), true);
  assert.equal(acceptance.isReviewedStatus('pending-human-editor-review'), false);
  assert.equal(acceptance.isReviewedStatus('template-not-reviewed'), false);
  assert.equal(acceptance.isReviewedStatus(null), false);
});

test('editor acceptance normalizes valid ratings and rejects empty or malformed reviews', () => {
  const normalized = acceptance.normalizeReviewEntry({
    assetId: 'asset_001',
    reviewerId: 'editor_01',
    type: 'character',
    extractionMode: 'SEGMENTED',
    quality: 0.8,
    useful: true,
    downloaded: true,
    artifactRating: 4,
    createdAt: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(normalized.reviewerId, 'editor_01');
  assert.equal(normalized.quality, 0.8);
  assert.equal(normalized.createdAt, '2026-09-01T10:00:00.000Z');
  assert.throws(
    () => acceptance.normalizeReviewEntry({ assetId: 'asset_001', reviewerId: 'editor_01' }),
    /Feedback cần/
  );
  assert.throws(
    () => acceptance.normalizeReviewEntry({ assetId: '../bad', useful: true }),
    /assetId/
  );
});

test('editor acceptance payload applies the top-level pseudonymous reviewer ID', async () => {
  const root = await fs.promises.mkdtemp(path.join(config.TEMP_DIR, 'editor-acceptance-'));
  const filePath = path.join(root, 'review.json');
  try {
    await fs.promises.writeFile(filePath, JSON.stringify({
      reviewStatus: 'human-editor-reviewed',
      reviewerId: 'editor_top',
      reviews: [{
        assetId: 'asset_001',
        type: 'image',
        extractionMode: 'DIRECT',
        useful: true,
      }],
    }), 'utf8');
    const payload = acceptance.readPayload(filePath);
    assert.equal(payload.reviewStatus, 'human-editor-reviewed');
    assert.equal(payload.reviews[0].reviewerId, 'editor_top');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
