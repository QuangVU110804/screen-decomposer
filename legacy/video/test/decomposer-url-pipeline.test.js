'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const config = require('../src/config');
const extractRoutes = require('../src/routes/extractRoutes');
const {
  createDecomposerJob,
  getJob,
  removeJob,
} = require('../src/services/jobService');

function uuid(seed) {
  return `80000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

test('mocked YouTube ingestion runs the same scene-first v2 pipeline as upload', async (t) => {
  const fixture = path.join(
    config.TEMP_DIR,
    'test-fixtures',
    'decomposer',
    'synthetic_decomposer_001.mp4'
  );
  if (!fs.existsSync(fixture)) {
    t.skip('Run npm.cmd run fixtures:decomposer to generate the URL integration fixture');
    return;
  }
  const jobId = uuid(Date.now() % 1_000_000);
  const downloadedPath = path.join(config.VIDEO_DIR, `${jobId}-download.mp4`);
  createDecomposerJob(jobId, {
    sourceType: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  const provider = {
    analyzeScene: async (scene) => ({
      input: {
        summary: `URL fixture ${scene.sceneId}`,
        elements: [{
          type: 'screenshot',
          description: `Reusable URL scene ${scene.sceneId}`,
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
      audit: { provider: 'mock', model: 'url-integration-v1' },
    }),
  };
  try {
    const result = await extractRoutes.runUrl(
      jobId,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      {
        downloadVideo: async (_url, _jobId, onProgress) => {
          await fs.promises.copyFile(fixture, downloadedPath);
          onProgress(1);
          return downloadedPath;
        },
        guardDuration: async () => 12,
        pipelineOptions: {
          sceneDetection: {
            rawEvents: [
              { timestamp: 4, type: 'hard_cut', confidence: 1 },
              { timestamp: 8, type: 'hard_cut', confidence: 1 },
            ],
          },
          keyframes: {
            keyframesPerScene: 1,
            maxKeyframesPerScene: 1,
            maxTotalKeyframes: 3,
          },
          sceneAnalysis: { provider, retries: 0 },
        },
      }
    );
    assert.equal(result.status, 'done');
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.scenes.length, 3);
    assert.equal(result.assets.length, 3);
    assert.ok(result.scenes.every((scene) => scene.analysis.status === 'complete'));
    assert.equal(getJob(jobId).sourceType, 'youtube');
    assert.ok(fs.existsSync(path.join(config.ASSET_DIR, jobId, 'manifest.json')));
  } finally {
    removeJob(jobId);
    await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(downloadedPath, { force: true });
  }
});
