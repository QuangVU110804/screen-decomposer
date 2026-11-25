'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sceneDetection = require('../src/services/sceneDetectionService');
const keyframes = require('../src/services/keyframeSelectionService');

test('scene detector retains sanitized raw and merged boundary evidence', async () => {
  const result = await sceneDetection.detectScenes(
    'foundation-evidence',
    'not-used.mp4',
    { duration: 3 },
    {
      createPreviews: false,
      minSceneDurationSec: 0.5,
      rawEvents: [
        {
          timestamp: 0.2,
          type: 'fade',
          confidence: 0.7,
          score: 0.22,
          signal: 'black_interval',
          interval: { start: 0.1, end: 0.3, duration: 0.2 },
        },
        {
          timestamp: 1.5,
          type: 'hard_cut',
          confidence: 0.95,
          score: 0.95,
          signal: 'ffmpeg_scene_score',
        },
      ],
    }
  );
  assert.deepEqual(
    result.scenes.map((scene) => [scene.start, scene.end]),
    [[0, 1.5], [1.5, 3]]
  );
  assert.equal(result.metrics.boundaryEvidence.length, 2);
  assert.equal(result.metrics.boundaryEvidence[0].interval.duration, 0.2);
  assert.equal(result.metrics.mergedBoundaryEvidence.length, 1);
  assert.equal(result.metrics.mergedBoundaryEvidence[0].reason, 'micro_scene_merged');
  assert.equal(JSON.stringify(result.metrics).includes('not-used.mp4'), false);

  const motionSamples = sceneDetection.parseMotionSamples(`
    frame:0 pts:0 pts_time:3.75
    lavfi.signalstats.YDIF=2.1
    frame:1 pts:1 pts_time:4
    lavfi.signalstats.YDIF=88.8426
    frame:2 pts:2 pts_time:4.25
    lavfi.signalstats.YDIF=1.8
    frame:3 pts:3 pts_time:4.5
    lavfi.signalstats.YDIF=2.2
  `);
  assert.deepEqual(motionSamples.map((sample) => sample.timestamp), [3.75, 4, 4.25, 4.5]);
  const motionEvents = sceneDetection.motionDiscontinuityEvents(motionSamples);
  assert.equal(motionEvents.length, 1);
  assert.equal(motionEvents[0].timestamp, 4);
  assert.equal(motionEvents[0].signal, 'signalstats_ydif_spike');
  const canonicalEvidence = sceneDetection.dedupeBoundaries([
    { timestamp: 4, type: 'motion_discontinuity', confidence: 0.95 },
    { timestamp: 4, type: 'hard_cut', confidence: 0.55 },
  ]);
  assert.equal(canonicalEvidence[0].type, 'hard_cut');
});

test('keyframe selection avoids black and transition candidates when safe evidence exists', () => {
  const candidates = [
    {
      timestamp: 0,
      hash: '0000000000000000',
      qualityScore: 1,
      blackFrame: true,
      transitionPenalty: 1,
    },
    {
      timestamp: 1,
      hash: '1111111111111111',
      qualityScore: 0.7,
      blackFrame: false,
      transitionPenalty: 0,
    },
    {
      timestamp: 2,
      hash: 'ffffffffffffffff',
      qualityScore: 0.6,
      blackFrame: false,
      transitionPenalty: 0.2,
    },
  ];
  const selected = keyframes.selectAnalysisCandidates(candidates, 2);
  assert.deepEqual(selected.map((candidate) => candidate.timestamp), [1, 2]);
});

test('keyframe cost summary reports pixels, latency and rejected evidence rates', () => {
  const summary = keyframes.summarizeKeyframeMetrics([
    {
      keyframes: [
        { features: { blackFrame: false } },
        { features: { blackFrame: true } },
      ],
      metrics: {
        visionPixelsEstimate: 200,
        selectionElapsedMs: 12,
        selectedTransitionFrames: 1,
      },
    },
    {
      keyframes: [{ features: { blackFrame: false } }],
      metrics: {
        visionPixelsEstimate: 100,
        selectionElapsedMs: 8,
        selectedTransitionFrames: 0,
      },
    },
  ], 2, 3);
  assert.deepEqual(summary, {
    totalKeyframes: 3,
    totalVisionPixelsEstimate: 300,
    totalSelectionElapsedMs: 20,
    selectedTransitionFrames: 1,
    selectedBlackFrames: 1,
    keyframeBudget: 2,
    effectiveKeyframeBudget: 3,
    budgetExpandedForCoverage: true,
  });
});
