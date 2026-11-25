'use strict';

const fs = require('fs');
const path = require('path');

function safeDivide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function f1(precision, recall) {
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function boundariesFromScenes(scenes) {
  return (scenes || []).slice(0, -1).map((scene) => Number(scene.end));
}

function boundaryMetrics(expectedScenes, predictedScenes, toleranceSec = 0.25) {
  const expected = boundariesFromScenes(expectedScenes);
  const predicted = boundariesFromScenes(predictedScenes);
  const used = new Set();
  let matched = 0;
  for (const target of expected) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < predicted.length; index++) {
      if (used.has(index)) continue;
      const distance = Math.abs(predicted[index] - target);
      if (distance <= toleranceSec && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matched++;
    }
  }
  const precision = safeDivide(matched, predicted.length);
  const recall = safeDivide(matched, expected.length);
  return {
    expected: expected.length,
    predicted: predicted.length,
    matched,
    precision,
    recall,
    f1: f1(precision, recall),
    toleranceSec,
  };
}

function bboxIou(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  const leftRight = left[0] + left[2];
  const leftBottom = left[1] + left[3];
  const rightRight = right[0] + right[2];
  const rightBottom = right[1] + right[3];
  const intersectionWidth = Math.max(0, Math.min(leftRight, rightRight) - Math.max(left[0], right[0]));
  const intersectionHeight = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(left[1], right[1]));
  const intersection = intersectionWidth * intersectionHeight;
  const union = left[2] * left[3] + right[2] * right[3] - intersection;
  return safeDivide(intersection, union);
}

function binaryMaskMetrics(expected, predicted, threshold = 127) {
  if (!expected || !predicted || expected.length !== predicted.length) {
    throw new Error('Mask arrays must have the same length');
  }
  let intersection = 0;
  let union = 0;
  let expectedForeground = 0;
  let predictedForeground = 0;
  for (let index = 0; index < expected.length; index++) {
    const expectedOn = Number(expected[index]) > threshold;
    const predictedOn = Number(predicted[index]) > threshold;
    if (expectedOn) expectedForeground++;
    if (predictedOn) predictedForeground++;
    if (expectedOn && predictedOn) intersection++;
    if (expectedOn || predictedOn) union++;
  }
  return {
    iou: safeDivide(intersection, union),
    precision: safeDivide(intersection, predictedForeground),
    recall: safeDivide(intersection, expectedForeground),
  };
}

function boundaryPixels(mask, width, height, threshold = 127) {
  if (!mask || mask.length !== width * height) {
    throw new Error('Mask length must equal width * height');
  }
  const boundary = [];
  const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (Number(mask[index]) <= threshold) continue;
      if (neighbors.some(([dx, dy]) => {
        const nextX = x + dx;
        const nextY = y + dy;
        return (
          nextX < 0 ||
          nextY < 0 ||
          nextX >= width ||
          nextY >= height ||
          Number(mask[nextY * width + nextX]) <= threshold
        );
      })) {
        boundary.push([x, y]);
      }
    }
  }
  return boundary;
}

function boundaryMatchRate(source, target, tolerancePx) {
  if (source.length === 0) return target.length === 0 ? 1 : 0;
  const toleranceSquared = tolerancePx ** 2;
  let matched = 0;
  for (const [x, y] of source) {
    if (target.some(([targetX, targetY]) => (
      (targetX - x) ** 2 + (targetY - y) ** 2 <= toleranceSquared
    ))) {
      matched++;
    }
  }
  return matched / source.length;
}

function binaryMaskBoundaryMetrics(
  expected,
  predicted,
  width,
  height,
  { threshold = 127, tolerancePx = 1 } = {}
) {
  const expectedBoundary = boundaryPixels(expected, width, height, threshold);
  const predictedBoundary = boundaryPixels(predicted, width, height, threshold);
  const precision = boundaryMatchRate(predictedBoundary, expectedBoundary, tolerancePx);
  const recall = boundaryMatchRate(expectedBoundary, predictedBoundary, tolerancePx);
  return {
    expectedBoundaryPixels: expectedBoundary.length,
    predictedBoundaryPixels: predictedBoundary.length,
    precision,
    recall,
    f1: f1(precision, recall),
    tolerancePx,
  };
}

function flattenElements(scenes) {
  return (scenes || []).flatMap((scene) => (scene.elements || []).map((element) => ({
    sceneId: scene.sceneId,
    type: element.type,
    bbox: element.bbox || element.observations?.[0]?.bbox,
    identity: element.identity || element.elementId,
    trackId: element.trackId || null,
  })));
}

function matchElementRecords(expectedScenes, predictedScenes, iouThreshold = 0.5) {
  const expected = flattenElements(expectedScenes);
  const predicted = flattenElements(predictedScenes);
  const used = new Set();
  const matches = [];
  for (const target of expected) {
    let bestIndex = -1;
    let bestIou = 0;
    for (let index = 0; index < predicted.length; index++) {
      if (used.has(index)) continue;
      const candidate = predicted[index];
      if (candidate.sceneId !== target.sceneId || candidate.type !== target.type) continue;
      const iou = bboxIou(target.bbox, candidate.bbox);
      if (iou >= iouThreshold && iou > bestIou) {
        bestIndex = index;
        bestIou = iou;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matches.push({ expected: target, predicted: predicted[bestIndex], iou: bestIou });
    }
  }
  return { expected, predicted, matches };
}

function elementMetrics(expectedScenes, predictedScenes, iouThreshold = 0.5) {
  const { expected, predicted, matches } = matchElementRecords(
    expectedScenes,
    predictedScenes,
    iouThreshold
  );
  const precision = safeDivide(matches.length, predicted.length);
  const recall = safeDivide(matches.length, expected.length);
  const byType = {};
  const types = new Set([...expected.map((item) => item.type), ...predicted.map((item) => item.type)]);
  for (const type of types) {
    const expectedCount = expected.filter((item) => item.type === type).length;
    const predictedCount = predicted.filter((item) => item.type === type).length;
    const matched = matches.filter((item) => item.expected.type === type).length;
    byType[type] = {
      expected: expectedCount,
      predicted: predictedCount,
      matched,
      precision: safeDivide(matched, predictedCount),
      recall: safeDivide(matched, expectedCount),
    };
  }
  return {
    expected: expected.length,
    predicted: predicted.length,
    matched: matches.length,
    precision,
    recall,
    f1: f1(precision, recall),
    meanIou: safeDivide(matches.reduce((sum, item) => sum + item.iou, 0), matches.length),
    iouThreshold,
    byType,
  };
}

function trackingMetrics(expectedScenes, predictedScenes, iouThreshold = 0.5) {
  const { expected, matches } = matchElementRecords(
    expectedScenes,
    predictedScenes,
    iouThreshold
  );
  const identityCounts = expected.reduce((counts, element) => ({
    ...counts,
    [element.identity]: (counts[element.identity] || 0) + 1,
  }), {});
  const trackableIdentities = Object.entries(identityCounts)
    .filter(([, count]) => count > 1)
    .map(([identity]) => identity);
  let idSwitches = 0;
  let fragmentedIdentities = 0;
  let matchedOccurrences = 0;
  for (const identity of trackableIdentities) {
    const observations = matches
      .filter((match) => match.expected.identity === identity)
      .sort((left, right) => left.expected.sceneId.localeCompare(right.expected.sceneId));
    matchedOccurrences += observations.length;
    const tracks = observations.map((match) => (
      match.predicted.trackId || match.predicted.identity
    ));
    const uniqueTracks = new Set(tracks);
    if (uniqueTracks.size > 1) fragmentedIdentities++;
    for (let index = 1; index < tracks.length; index++) {
      if (tracks[index] !== tracks[index - 1]) idSwitches++;
    }
  }
  return {
    trackableIdentities: trackableIdentities.length,
    expectedOccurrences: trackableIdentities.reduce(
      (sum, identity) => sum + identityCounts[identity],
      0
    ),
    matchedOccurrences,
    idSwitches,
    fragmentedIdentities,
    idSwitchRate: safeDivide(idSwitches, Math.max(0, matchedOccurrences - trackableIdentities.length)),
  };
}

function dedupeMetrics(expectedAssets, predictedAssets) {
  const expectedIdentities = new Set((expectedAssets || []).map((asset) => asset.identity));
  const predictedIdentities = new Set((predictedAssets || []).map((asset) => asset.identity || asset.assetId));
  const falseMerges = (predictedAssets || []).filter((asset) => (
    new Set((asset.occurrences || []).map((item) => item.identity).filter(Boolean)).size > 1
  )).length;
  return {
    expectedIdentities: expectedIdentities.size,
    predictedIdentities: predictedIdentities.size,
    duplicateKept: Math.max(0, predictedIdentities.size - expectedIdentities.size),
    falseMerges,
    duplicateKeptRate: safeDivide(
      Math.max(0, predictedIdentities.size - expectedIdentities.size),
      expectedIdentities.size
    ),
    falseMergeRate: safeDivide(falseMerges, predictedIdentities.size),
  };
}

function evaluate(groundTruth, prediction) {
  const expectedVideo = groundTruth.videos?.[0] || groundTruth;
  const predictedVideo = prediction.videos?.[0] || prediction;
  const boundary = boundaryMetrics(
    expectedVideo.scenes,
    predictedVideo.scenes,
    groundTruth.thresholds?.boundaryToleranceSec || 0.25
  );
  const elements = elementMetrics(
    expectedVideo.scenes,
    predictedVideo.scenes,
    groundTruth.thresholds?.bboxIou || 0.5
  );
  const tracking = trackingMetrics(
    expectedVideo.scenes,
    predictedVideo.scenes,
    groundTruth.thresholds?.bboxIou || 0.5
  );
  const dedupe = dedupeMetrics(expectedVideo.assets, predictedVideo.assets);
  const thresholds = groundTruth.thresholds || {};
  const gates = {
    boundaryF1: boundary.f1 >= Number(thresholds.boundaryF1 || 0),
    elementPrecision: elements.precision >= Number(thresholds.elementPrecision || 0),
    elementRecall: elements.recall >= Number(thresholds.elementRecall || 0),
    bboxIou: elements.meanIou >= Number(thresholds.bboxIou || 0),
    duplicateKeptRate: dedupe.duplicateKeptRate <= Number(thresholds.duplicateKeptRate ?? 1),
    falseMergeRate: dedupe.falseMergeRate <= Number(thresholds.falseMergeRate ?? 1),
  };
  gates.passed = Object.values(gates).every(Boolean);
  return {
    boundary,
    elements,
    tracking,
    dedupe,
    gates,
  };
}

function main() {
  const root = path.join(__dirname, '..');
  const groundTruthPath = process.argv[2] || path.join(root, 'test', 'fixtures', 'decomposer', 'ground-truth.json');
  const predictionPath = process.argv[3] || path.join(root, 'test', 'fixtures', 'decomposer', 'example-prediction.json');
  const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(predictionPath, 'utf8'));
  console.log(JSON.stringify(evaluate(groundTruth, prediction), null, 2));
}

if (require.main === module) main();

module.exports = {
  safeDivide,
  f1,
  boundaryMetrics,
  bboxIou,
  binaryMaskMetrics,
  boundaryPixels,
  binaryMaskBoundaryMetrics,
  matchElementRecords,
  elementMetrics,
  trackingMetrics,
  dedupeMetrics,
  evaluate,
};
