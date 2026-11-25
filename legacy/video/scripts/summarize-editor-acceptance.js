'use strict';

const fs = require('fs');
const path = require('path');
const {
  normalizeFeedback,
  summarizeFeedback,
} = require('../src/services/feedbackService');

const REVIEWED_STATUSES = new Set(['human-editor-reviewed', 'reviewed', 'approved']);

function parseArgs(argv) {
  const options = { files: [], output: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--output') options.output = argv[++index];
    else options.files.push(arg);
  }
  return options;
}

function readPayload(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const reviews = Array.isArray(payload) ? payload : payload.reviews;
  if (!Array.isArray(reviews)) throw new Error(`${filePath} does not contain a reviews array`);
  return {
    reviews: reviews.map((review) => ({
      ...review,
      reviewerId: review.reviewerId || payload.reviewerId,
    })),
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    reviewStatus: payload.reviewStatus || null,
  };
}

function isReviewedStatus(value) {
  return REVIEWED_STATUSES.has(String(value || '').toLowerCase());
}

function normalizeReviewEntry(review) {
  if (!/^asset_\d{3,}$/.test(String(review?.assetId || ''))) {
    throw new Error(`assetId không hợp lệ trong editor review: ${review?.assetId || '(missing)'}`);
  }
  const createdAt = Date.parse(review.createdAt);
  const normalized = normalizeFeedback({
    assetId: review.assetId,
    type: review.type || 'unknown',
    extractionMode: review.extractionMode || 'UNKNOWN',
    quality: Number(review.quality || 0),
  }, review, Number.isFinite(createdAt) ? new Date(createdAt) : new Date());
  return {
    ...normalized,
    feedbackId: review.feedbackId || normalized.feedbackId,
    createdAt: Number.isFinite(createdAt)
      ? new Date(createdAt).toISOString()
      : normalized.createdAt,
  };
}

function main() {
  const root = path.join(__dirname, '..');
  const options = parseArgs(process.argv.slice(2));
  if (options.files.length === 0) {
    console.error(
      'Usage: node scripts/summarize-editor-acceptance.js <review.json> [...] [--output report.json]'
    );
    process.exit(2);
  }
  const groundTruth = JSON.parse(
    fs.readFileSync(path.join(root, 'test', 'fixtures', 'decomposer', 'ground-truth.json'), 'utf8')
  );
  const payloads = options.files.map((filePath) => readPayload(path.resolve(filePath)));
  const reviews = payloads.flatMap((payload) => payload.reviews).map(normalizeReviewEntry);
  const assets = payloads.flatMap((payload) => payload.assets);
  const summary = summarizeFeedback(reviews, assets, groundTruth.thresholds || {});
  const sourceReviewStatuses = payloads.map((payload) => payload.reviewStatus);
  const reviewedSources = sourceReviewStatuses.length > 0 &&
    sourceReviewStatuses.every(isReviewedStatus);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: options.files.map((filePath) => path.resolve(filePath)),
    sourceReviewStatuses,
    summary,
    releaseGate: {
      reviewedSources,
      metricsPassed: summary.gate.passed,
      passed: reviewedSources && summary.gate.passed,
      claim: reviewedSources
        ? 'Editor utility metrics come from sources explicitly marked as human reviewed.'
        : 'No editor-acceptance release claim is made until every source is marked human-editor-reviewed.',
    },
    limitations: [
      'A passing aggregate does not replace qualitative review of individual visual artifacts.',
      'Reviewer identity is pseudonymous and no legal reuse permission is inferred.',
    ],
  };
  const output = JSON.stringify(report, null, 2);
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(path.resolve(options.output), output, 'utf8');
  }
  console.log(output);
  if (!report.releaseGate.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Editor acceptance input invalid: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {
  REVIEWED_STATUSES,
  parseArgs,
  readPayload,
  isReviewedStatus,
  normalizeReviewEntry,
};
