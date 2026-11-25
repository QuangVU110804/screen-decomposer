'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const config = require('../src/config');
const { createDecomposerJob, removeJob } = require('../src/services/jobService');
const pipeline = require('../src/pipeline/pipelineService');
const backgroundRecovery = require('../src/services/backgroundRecoveryService');

function uuid(seed) {
  return `50000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function observation(keyframeRef, bbox, values = {}) {
  return {
    keyframeRef,
    bbox,
    visibility: values.visibility ?? 0.95,
    occlusion: values.occlusion ?? 0,
    motion: values.motion ?? 0,
  };
}

test('synthetic MVP produces every committed element family across DIRECT, SEGMENTED and RECONSTRUCTED modes', async (t) => {
  const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'decomposer', 'synthetic_decomposer_001.mp4');
  if (!fs.existsSync(fixture)) {
    t.skip('Run npm.cmd run fixtures:decomposer to generate the synthetic MVP fixture');
    return;
  }
  const jobId = uuid(Date.now() % 1_000_000);
  const inputPath = path.join(config.VIDEO_DIR, `${jobId}.mp4`);
  const previousBackgroundFlag = config.ENABLE_BACKGROUND_RECOVERY;
  await fs.promises.copyFile(fixture, inputPath);
  createDecomposerJob(jobId, { sourceType: 'upload', originalFilename: 'synthetic_decomposer_001.mp4' });
  config.ENABLE_BACKGROUND_RECOVERY = true;
  const provider = {
    analyzeScene: async (scene) => {
      const byScene = {
        scene_001: [
          {
            type: 'person',
            description: 'Synthetic presenter',
            extractability: 'segmentable',
            semanticConfidence: 0.96,
            localizationConfidence: 0.94,
            observations: [observation(0, [0.08, 0.12, 0.27, 0.84])],
          },
          {
            type: 'background',
            description: 'Blue studio background',
            extractability: 'requires_inpainting',
            semanticConfidence: 0.94,
            localizationConfidence: 0.92,
            observations: [observation(0, [0, 0, 1, 1], { visibility: 0.75, occlusion: 0.25 })],
          },
          {
            type: 'text',
            description: 'Synthetic lower third',
            text: 'SYNTHETIC PRESENTER',
            textStyle: { color: 'white', alignment: 'left', weight: 'bold' },
            extractability: 'direct',
            semanticConfidence: 0.98,
            localizationConfidence: 0.96,
            observations: [observation(0, [0.08, 0.77, 0.49, 0.18])],
          },
        ],
        scene_002: [
          {
            type: 'screenshot',
            description: 'Synthetic website screenshot',
            extractability: 'direct',
            semanticConfidence: 0.97,
            localizationConfidence: 0.95,
            observations: [observation(0, [0.11, 0.11, 0.78, 0.78])],
          },
          {
            type: 'graphic',
            description: 'Red arrow graphic',
            extractability: 'direct',
            semanticConfidence: 0.93,
            localizationConfidence: 0.93,
            observations: [observation(0, [0.72, 0.55, 0.21, 0.3])],
          },
        ],
        scene_003: [
          {
            type: 'character',
            description: 'Synthetic blue character',
            extractability: 'segmentable',
            semanticConfidence: 0.96,
            localizationConfidence: 0.94,
            observations: [observation(0, [0.57, 0.1, 0.34, 0.86])],
          },
          {
            type: 'image',
            description: 'Synthetic poster image',
            extractability: 'direct',
            semanticConfidence: 0.95,
            localizationConfidence: 0.95,
            observations: [observation(0, [0.07, 0.16, 0.4, 0.72])],
          },
        ],
      };
      return {
        input: { summary: `MVP ${scene.sceneId}`, elements: byScene[scene.sceneId] || [] },
        audit: { provider: 'mock', model: 'synthetic-mvp-v1' },
      };
    },
  };
  const inpaintProvider = {
    inpaint: async ({ imageBuffer, maskBuffer, width, height }) => (
      backgroundRecovery.localInpaint(imageBuffer, maskBuffer, width, height)
    ),
  };
  try {
    const result = await pipeline.runDecomposer(jobId, inputPath, {
      sceneDetection: {
        rawEvents: [
          { timestamp: 4, type: 'hard_cut', confidence: 1 },
          { timestamp: 8, type: 'hard_cut', confidence: 1 },
        ],
      },
      keyframes: { keyframesPerScene: 1, maxKeyframesPerScene: 1, maxTotalKeyframes: 3 },
      sceneAnalysis: { provider, retries: 0 },
      backgroundRecovery: { provider: inpaintProvider },
    });
    const successful = result.assets.filter((asset) => asset.extractionMode !== 'FAILED');
    const typeMode = new Map(successful.map((asset) => [asset.type, asset.extractionMode]));
    assert.equal(typeMode.get('person'), 'SEGMENTED');
    assert.equal(typeMode.get('character'), 'SEGMENTED');
    assert.equal(typeMode.get('background'), 'RECONSTRUCTED');
    assert.equal(typeMode.get('image'), 'DIRECT');
    assert.equal(typeMode.get('screenshot'), 'DIRECT');
    assert.equal(typeMode.get('text'), 'DIRECT');
    assert.equal(typeMode.get('graphic'), 'DIRECT');
    const reconstructed = successful.find((asset) => asset.type === 'background');
    assert.ok(reconstructed.reconstructedAreaRatio > 0);
    assert.ok(fs.existsSync(reconstructed.files.reconstructedMask));
    assert.ok(fs.existsSync(path.join(config.ASSET_DIR, jobId, 'scene_001', 'metadata.json')));
    assert.equal(result.metrics.keyframes.selectedBlackFrames, 0);
    assert.equal(result.metrics.keyframes.selectedTransitionFrames, 0);
    assert.ok(result.metrics.keyframes.totalVisionPixelsEstimate > 0);
    assert.ok(result.metrics.keyframes.totalSelectionElapsedMs >= 0);
  } finally {
    config.ENABLE_BACKGROUND_RECOVERY = previousBackgroundFlag;
    removeJob(jobId);
    await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(inputPath, { force: true });
  }
});
