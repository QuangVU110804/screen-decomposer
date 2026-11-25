'use strict';

const { randomUUID } = require('crypto');

function finiteOrNull(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function optionalBoolean(input, field) {
  const value = input[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${field} phải là boolean`);
  }
  return value;
}

function optionalNumber(input, field, options) {
  const value = input[field];
  if (value === undefined || value === null || value === '') return null;
  const number = finiteOrNull(value, options);
  if (number === null) {
    throw new Error(`${field} không hợp lệ`);
  }
  return number;
}

function normalizeReviewerId(value) {
  const reviewerId = String(value || 'anonymous').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(reviewerId)) {
    throw new Error('reviewerId không hợp lệ');
  }
  return reviewerId;
}

function normalizeFeedback(asset, input = {}, now = new Date()) {
  const useful = optionalBoolean(input, 'useful');
  const downloaded = optionalBoolean(input, 'downloaded');
  const timeSavedMinutes = optionalNumber(input, 'timeSavedMinutes', { min: 0, max: 600 });
  const artifactRating = optionalNumber(input, 'artifactRating', { min: 1, max: 5 });
  if (
    useful === null &&
    downloaded === null &&
    timeSavedMinutes === null &&
    artifactRating === null
  ) {
    throw new Error('Feedback cần useful, downloaded, timeSavedMinutes hoặc artifactRating hợp lệ');
  }
  return {
    feedbackId: randomUUID(),
    reviewerId: normalizeReviewerId(input.reviewerId),
    assetId: asset.assetId,
    type: asset.type,
    extractionMode: asset.extractionMode,
    quality: Number(asset.quality || 0),
    useful,
    downloaded,
    timeSavedMinutes,
    artifactRating,
    comment: typeof input.comment === 'string' ? input.comment.trim().slice(0, 500) : '',
    createdAt: now.toISOString(),
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rate(values) {
  return values.length ? values.filter(Boolean).length / values.length : null;
}

function aggregateGroup(entries) {
  const useful = entries.map((entry) => entry.useful).filter((value) => typeof value === 'boolean');
  const downloaded = entries.map((entry) => entry.downloaded).filter((value) => typeof value === 'boolean');
  const timeSaved = entries.map((entry) => entry.timeSavedMinutes).filter(Number.isFinite);
  const artifactRatings = entries.map((entry) => entry.artifactRating).filter(Number.isFinite);
  return {
    ratings: entries.length,
    usefulRatings: useful.length,
    usefulRate: rate(useful),
    downloadRatings: downloaded.length,
    downloadIntentRate: rate(downloaded),
    averageTimeSavedMinutes: average(timeSaved),
    averageArtifactRating: average(artifactRatings),
  };
}

const PARTIAL_RATING_FIELDS = Object.freeze([
  'useful',
  'downloaded',
  'timeSavedMinutes',
  'artifactRating',
]);

function mergeLatestRatings(entries) {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      String(left.entry.createdAt || '').localeCompare(String(right.entry.createdAt || '')) ||
      left.index - right.index
    ));
  const latest = new Map();
  for (const { entry } of ordered) {
    const key = `${entry.reviewerId || 'anonymous'}:${entry.assetId}`;
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, { ...entry });
      continue;
    }
    const merged = { ...previous, ...entry };
    for (const field of PARTIAL_RATING_FIELDS) {
      if (entry[field] === null || entry[field] === undefined) {
        merged[field] = previous[field] ?? null;
      }
    }
    latest.set(key, merged);
  }
  return [...latest.values()];
}

function pearson(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = average(left);
  const rightMean = average(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : null;
}

function ranks(values) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const result = new Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const rank = (start + 1 + end) / 2;
    for (let index = start; index < end; index++) result[sorted[index].index] = rank;
    start = end;
  }
  return result;
}

function spearman(entries, field, transform = Number) {
  const pairs = entries
    .filter((entry) => Number.isFinite(Number(entry.quality)) && entry[field] !== null && entry[field] !== undefined)
    .map((entry) => ({
      quality: Number(entry.quality),
      rating: transform(entry[field]),
    }))
    .filter((pair) => Number.isFinite(pair.rating));
  return {
    samples: pairs.length,
    correlation: pairs.length >= 2
      ? pearson(ranks(pairs.map((pair) => pair.quality)), ranks(pairs.map((pair) => pair.rating)))
      : null,
  };
}

function summarizeFeedback(feedback, assets = [], thresholds = {}) {
  const assetMap = new Map((assets || []).map((asset) => [asset.assetId, asset]));
  const normalized = (feedback || []).map((entry) => {
    const asset = assetMap.get(entry.assetId);
    return {
      ...entry,
      type: entry.type || asset?.type || 'unknown',
      extractionMode: entry.extractionMode || asset?.extractionMode || 'UNKNOWN',
    };
  });
  const ratings = mergeLatestRatings(normalized);
  const byType = {};
  const byMode = {};
  for (const entry of ratings) {
    (byType[entry.type] ||= []).push(entry);
    (byMode[entry.extractionMode] ||= []).push(entry);
  }
  const summary = {
    eventCount: normalized.length,
    reviewerCount: new Set(ratings.map((entry) => entry.reviewerId || 'anonymous')).size,
    reviewedAssetCount: new Set(ratings.map((entry) => entry.assetId)).size,
    ...aggregateGroup(ratings),
    byType: Object.fromEntries(Object.entries(byType).map(([key, values]) => [key, aggregateGroup(values)])),
    byMode: Object.fromEntries(Object.entries(byMode).map(([key, values]) => [key, aggregateGroup(values)])),
    qualityCalibration: {
      useful: spearman(ratings, 'useful', (value) => value ? 1 : 0),
      downloadIntent: spearman(ratings, 'downloaded', (value) => value ? 1 : 0),
      artifactRating: spearman(ratings, 'artifactRating'),
    },
  };
  const minimumRatings = Number(thresholds.minimumEditorRatings || 1);
  const requiredUsefulRate = Number(thresholds.editorUsefulRate || 0);
  const requiredDownloadRate = Number(thresholds.editorDownloadIntentRate || 0);
  const usefulPass = summary.usefulRate !== null && summary.usefulRate >= requiredUsefulRate;
  const downloadPass = summary.downloadIntentRate !== null && summary.downloadIntentRate >= requiredDownloadRate;
  summary.gate = {
    minimumRatings,
    actualRatings: summary.usefulRatings,
    requiredUsefulRate,
    requiredDownloadIntentRate: requiredDownloadRate,
    enoughRatings: summary.usefulRatings >= minimumRatings,
    usefulPass,
    downloadIntentPass: downloadPass,
    passed: summary.usefulRatings >= minimumRatings && usefulPass && downloadPass,
  };
  return summary;
}

module.exports = {
  finiteOrNull,
  normalizeReviewerId,
  normalizeFeedback,
  mergeLatestRatings,
  pearson,
  ranks,
  spearman,
  summarizeFeedback,
};
