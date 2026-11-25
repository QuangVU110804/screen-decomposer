'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const config = require('../src/config');
const { createDecomposerJob, getJob, removeJob } = require('../src/services/jobService');
const pipeline = require('../src/pipeline/pipelineService');
const { serializeV2Job } = require('../src/utils/serialize');

function uuid(seed) {
  return `30000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

test('mock-provider upload runs scene-first pipeline end to end and retains source for scene retry', async (t) => {
  const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'slideshow.mp4');
  if (!fs.existsSync(fixture)) {
    t.skip('slideshow fixture is not available');
    return;
  }
  const jobId = uuid(Date.now() % 1_000_000);
  const inputPath = path.join(config.VIDEO_DIR, `${jobId}.mp4`);
  await fs.promises.copyFile(fixture, inputPath);
  createDecomposerJob(jobId, { sourceType: 'upload', originalFilename: 'slideshow.mp4' });
  let failingSceneId = 'scene_004';
  const provider = {
    analyzeScene: async (scene) => {
      if (scene.sceneId === failingSceneId) throw new Error('deliberate isolated scene failure');
      return {
      input: {
        summary: `Synthetic ${scene.sceneId}`,
        elements: [{
          type: 'screenshot',
          description: `Synthetic slide ${scene.sceneId}`,
          extractability: 'direct',
          semanticConfidence: 0.95,
          localizationConfidence: 0.95,
          observations: [{
            keyframeRef: 0,
            bbox: [0, 0, 1, 1],
            visibility: 1,
            occlusion: 0,
            motion: 0,
          }],
        }],
      },
      audit: { provider: 'mock', model: 'deterministic-v1' },
      };
    },
  };
  try {
    const result = await pipeline.runDecomposer(jobId, inputPath, {
      sceneDetection: {
        rawEvents: [
          { timestamp: 6, type: 'hard_cut', confidence: 1 },
          { timestamp: 10, type: 'hard_cut', confidence: 1 },
          { timestamp: 14, type: 'hard_cut', confidence: 1 },
        ],
      },
      keyframes: { keyframesPerScene: 1, maxKeyframesPerScene: 1, maxTotalKeyframes: 4 },
      sceneAnalysis: { provider, retries: 0 },
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.scenes.length, 4);
    assert.ok(result.scenes.every((scene) => scene.keyframes.length === 1));
    assert.equal(result.scenes.filter((scene) => scene.elements.length === 1).length, 3);
    assert.equal(result.scenes.find((scene) => scene.sceneId === 'scene_004').analysis.status, 'failed');
    assert.equal(result.assets.length, 3);
    assert.ok(fs.existsSync(result.videoPath), 'source is retained through packaging for scene retry');
    assert.ok(fs.existsSync(path.join(config.ASSET_DIR, jobId, 'manifest.json')));
    const persisted = getJob(jobId);
    assert.equal(persisted.status, 'partial');
    const serialized = JSON.stringify(serializeV2Job(persisted));
    assert.equal(serialized.includes('videoPath'), false);
    assert.equal(serialized.includes('requestId'), false);

    failingSceneId = null;
    const rerun = await pipeline.reanalyzeScene(jobId, 'scene_004', {
      sceneAnalysis: { provider, retries: 0 },
      segmentation: {},
    });
    assert.equal(rerun.status, 'done');
    assert.equal(new Set(rerun.scenes.map((scene) => scene.sceneId)).size, rerun.scenes.length);
    assert.equal(new Set(rerun.assets.map((asset) => asset.assetId)).size, rerun.assets.length);
    assert.deepEqual(rerun.assets.map((asset) => asset.assetId).sort(), [
      'asset_001', 'asset_002', 'asset_003', 'asset_004',
    ]);

    const stableAssetIds = rerun.assets.map((asset) => asset.assetId);
    const stableManifest = await fs.promises.readFile(
      path.join(config.ASSET_DIR, jobId, 'manifest.json'),
      'utf8'
    );
    failingSceneId = 'scene_001';
    const failedRetry = await pipeline.reanalyzeScene(jobId, 'scene_001', {
      sceneAnalysis: { provider, retries: 0 },
    });
    assert.equal(failedRetry.status, 'partial');
    assert.deepEqual(failedRetry.assets.map((asset) => asset.assetId), stableAssetIds);
    assert.ok(failedRetry.failures.some((failure) => (
      failure.sceneId === 'scene_001' &&
      failure.code === 'SCENE_REANALYSIS_FAILED'
    )));
    assert.equal(
      await fs.promises.readFile(path.join(config.ASSET_DIR, jobId, 'manifest.json'), 'utf8'),
      stableManifest
    );
  } finally {
    removeJob(jobId);
    await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(inputPath, { force: true });
  }
});
