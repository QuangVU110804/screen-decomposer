'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const evaluation = require('../scripts/evaluate-decomposer');

test('evaluation measures boundary F1, bbox IoU, element recall and dedupe errors', () => {
  const fixtureRoot = path.join(__dirname, 'fixtures', 'decomposer');
  const truth = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'ground-truth.json'), 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'example-prediction.json'), 'utf8'));
  const result = evaluation.evaluate(truth, prediction);
  assert.equal(result.boundary.f1, 1);
  assert.equal(result.elements.recall, 1);
  assert.ok(result.elements.meanIou > 0.9);
  assert.equal(result.dedupe.falseMerges, 0);
  assert.equal(result.dedupe.duplicateKeptRate, 0);
  assert.equal(result.tracking.trackableIdentities, 1);
  assert.equal(result.tracking.matchedOccurrences, 2);
  assert.equal(result.tracking.idSwitches, 0);
  assert.equal(result.gates.passed, true);
  assert.equal(evaluation.bboxIou([0, 0, 0.5, 0.5], [0.25, 0.25, 0.5, 0.5]), 1 / 7);
  assert.deepEqual(
    evaluation.binaryMaskMetrics([0, 255, 255, 0], [0, 255, 0, 0]),
    { iou: 0.5, precision: 1, recall: 0.5 }
  );
  assert.deepEqual(
    evaluation.binaryMaskBoundaryMetrics(
      [0, 0, 0, 0, 255, 255, 0, 255, 255],
      [0, 0, 0, 0, 255, 255, 0, 255, 255],
      3,
      3
    ),
    {
      expectedBoundaryPixels: 4,
      predictedBoundaryPixels: 4,
      precision: 1,
      recall: 1,
      f1: 1,
      tolerancePx: 1,
    }
  );
});

test('tracking evaluation counts identity switches across scenes', () => {
  const expected = [
    { sceneId: 'scene_001', elements: [{ identity: 'character_a', type: 'character', bbox: [0, 0, 0.5, 1] }] },
    { sceneId: 'scene_002', elements: [{ identity: 'character_a', type: 'character', bbox: [0, 0, 0.5, 1] }] },
  ];
  const predicted = [
    { sceneId: 'scene_001', elements: [{ elementId: 'element_001_01', trackId: 'track_001', type: 'character', observations: [{ bbox: [0, 0, 0.5, 1] }] }] },
    { sceneId: 'scene_002', elements: [{ elementId: 'element_002_01', trackId: 'track_002', type: 'character', observations: [{ bbox: [0, 0, 0.5, 1] }] }] },
  ];
  assert.deepEqual(evaluation.trackingMetrics(expected, predicted), {
    trackableIdentities: 1,
    expectedOccurrences: 2,
    matchedOccurrences: 2,
    idSwitches: 1,
    fragmentedIdentities: 1,
    idSwitchRate: 1,
  });
});
