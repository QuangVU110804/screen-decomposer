'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeFeedback,
  normalizeReviewerId,
  summarizeFeedback,
} = require('../src/services/feedbackService');

const assets = [
  {
    assetId: 'asset_001',
    type: 'person',
    extractionMode: 'SEGMENTED',
    quality: 0.82,
  },
  {
    assetId: 'asset_002',
    type: 'background',
    extractionMode: 'RECONSTRUCTED',
    quality: 0.74,
  },
];

test('feedback normalization validates reviewer and rating fields', () => {
  const now = new Date('2026-09-01T08:30:00.000Z');
  const feedback = normalizeFeedback(assets[0], {
    reviewerId: 'editor_01',
    useful: true,
    downloaded: false,
    timeSavedMinutes: '12.5',
    artifactRating: 4,
    comment: `  ${'x'.repeat(510)}  `,
  }, now);

  assert.match(feedback.feedbackId, /^[0-9a-f-]{36}$/);
  assert.equal(feedback.reviewerId, 'editor_01');
  assert.equal(feedback.assetId, 'asset_001');
  assert.equal(feedback.type, 'person');
  assert.equal(feedback.extractionMode, 'SEGMENTED');
  assert.equal(feedback.quality, 0.82);
  assert.equal(feedback.useful, true);
  assert.equal(feedback.downloaded, false);
  assert.equal(feedback.timeSavedMinutes, 12.5);
  assert.equal(feedback.artifactRating, 4);
  assert.equal(feedback.comment.length, 500);
  assert.equal(feedback.createdAt, now.toISOString());

  assert.equal(normalizeReviewerId(undefined), 'anonymous');
  assert.throws(
    () => normalizeFeedback(assets[0], { reviewerId: 'bad reviewer!', useful: true }),
    /reviewerId/
  );
  assert.throws(
    () => normalizeFeedback(assets[0], { useful: 'yes', downloaded: true }),
    /useful/
  );
  assert.throws(
    () => normalizeFeedback(assets[0], { useful: true, artifactRating: 6 }),
    /artifactRating/
  );
  assert.throws(
    () => normalizeFeedback(assets[0], { timeSavedMinutes: -1 }),
    /timeSavedMinutes/
  );
  assert.throws(
    () => normalizeFeedback(assets[0], {}),
    /Feedback cần/
  );
});

test('feedback summary keeps the latest reviewer/asset rating and aggregates by type and mode', () => {
  const feedback = [
    {
      reviewerId: 'editor_a',
      assetId: 'asset_001',
      useful: false,
      downloaded: false,
      timeSavedMinutes: 2,
      artifactRating: 2,
      createdAt: '2026-09-01T08:00:00.000Z',
    },
    {
      reviewerId: 'editor_a',
      assetId: 'asset_001',
      useful: true,
      downloaded: true,
      timeSavedMinutes: 4,
      artifactRating: 4,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    {
      reviewerId: 'editor_b',
      assetId: 'asset_001',
      useful: false,
      downloaded: true,
      timeSavedMinutes: 6,
      artifactRating: 3,
      createdAt: '2026-09-01T09:30:00.000Z',
    },
    {
      reviewerId: 'editor_a',
      assetId: 'asset_002',
      useful: true,
      downloaded: false,
      timeSavedMinutes: 8,
      artifactRating: 5,
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ];

  const summary = summarizeFeedback(feedback, assets);

  assert.equal(summary.eventCount, 4);
  assert.equal(summary.ratings, 3);
  assert.equal(summary.reviewerCount, 2);
  assert.equal(summary.reviewedAssetCount, 2);
  assert.equal(summary.usefulRate, 2 / 3);
  assert.equal(summary.downloadIntentRate, 2 / 3);
  assert.equal(summary.averageTimeSavedMinutes, 6);
  assert.equal(summary.averageArtifactRating, 4);
  assert.equal(summary.byType.person.ratings, 2);
  assert.equal(summary.byType.person.usefulRate, 0.5);
  assert.equal(summary.byType.background.usefulRate, 1);
  assert.equal(summary.byMode.SEGMENTED.downloadIntentRate, 1);
  assert.equal(summary.byMode.RECONSTRUCTED.downloadIntentRate, 0);
});

test('partial feedback events merge by reviewer and asset without losing prior intent', () => {
  const feedback = [
    {
      reviewerId: 'editor_a',
      assetId: 'asset_001',
      type: 'person',
      extractionMode: 'SEGMENTED',
      quality: 0.82,
      useful: null,
      downloaded: true,
      timeSavedMinutes: null,
      artifactRating: null,
      createdAt: '2026-09-01T08:00:00.000Z',
    },
    {
      reviewerId: 'editor_a',
      assetId: 'asset_001',
      type: 'person',
      extractionMode: 'SEGMENTED',
      quality: 0.82,
      useful: true,
      downloaded: null,
      timeSavedMinutes: 5,
      artifactRating: null,
      createdAt: '2026-09-01T08:01:00.000Z',
    },
    {
      reviewerId: 'editor_a',
      assetId: 'asset_001',
      type: 'person',
      extractionMode: 'SEGMENTED',
      quality: 0.82,
      useful: null,
      downloaded: null,
      timeSavedMinutes: null,
      artifactRating: 4,
      createdAt: '2026-09-01T08:02:00.000Z',
    },
  ];
  const summary = summarizeFeedback(feedback, assets);
  assert.equal(summary.eventCount, 3);
  assert.equal(summary.ratings, 1);
  assert.equal(summary.usefulRate, 1);
  assert.equal(summary.downloadIntentRate, 1);
  assert.equal(summary.averageTimeSavedMinutes, 5);
  assert.equal(summary.averageArtifactRating, 4);
});

test('feedback summary reports rank correlation between technical quality and editor outcomes', () => {
  const feedback = [
    { reviewerId: 'a', assetId: 'asset_001', quality: 0.9, useful: true, downloaded: true, artifactRating: 5, createdAt: '2026-09-01T08:00:00.000Z' },
    { reviewerId: 'b', assetId: 'asset_002', quality: 0.7, useful: true, downloaded: true, artifactRating: 4, createdAt: '2026-09-01T08:01:00.000Z' },
    { reviewerId: 'c', assetId: 'asset_003', quality: 0.3, useful: false, downloaded: false, artifactRating: 1, createdAt: '2026-09-01T08:02:00.000Z' },
  ];
  const summary = summarizeFeedback(feedback);
  assert.equal(summary.qualityCalibration.useful.samples, 3);
  assert.ok(summary.qualityCalibration.useful.correlation > 0.8);
  assert.ok(summary.qualityCalibration.downloadIntent.correlation > 0.8);
  assert.equal(summary.qualityCalibration.artifactRating.correlation, 1);
});

test('editor utility gate reports independent pass and failure reasons', () => {
  const feedback = [
    { reviewerId: 'a', assetId: 'asset_001', useful: true, downloaded: true, createdAt: '2026-09-01T08:00:00.000Z' },
    { reviewerId: 'b', assetId: 'asset_001', useful: true, downloaded: false, createdAt: '2026-09-01T08:01:00.000Z' },
    { reviewerId: 'c', assetId: 'asset_002', useful: false, downloaded: true, createdAt: '2026-09-01T08:02:00.000Z' },
  ];

  const passing = summarizeFeedback(feedback, assets, {
    minimumEditorRatings: 3,
    editorUsefulRate: 0.6,
    editorDownloadIntentRate: 0.5,
  });
  assert.deepEqual(passing.gate, {
    minimumRatings: 3,
    actualRatings: 3,
    requiredUsefulRate: 0.6,
    requiredDownloadIntentRate: 0.5,
    enoughRatings: true,
    usefulPass: true,
    downloadIntentPass: true,
    passed: true,
  });

  const failing = summarizeFeedback(feedback, assets, {
    minimumEditorRatings: 4,
    editorUsefulRate: 0.8,
    editorDownloadIntentRate: 0.8,
  });
  assert.equal(failing.gate.enoughRatings, false);
  assert.equal(failing.gate.usefulPass, false);
  assert.equal(failing.gate.downloadIntentPass, false);
  assert.equal(failing.gate.passed, false);
});
