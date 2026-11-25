'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');
const config = require('../src/config');
const artifactStore = require('../src/services/artifactStore');
const sceneAnalysis = require('../src/services/sceneAnalysisService');

function uuid(seed) {
  return `40000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

async function cleanup(jobId) {
  await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
}

test('scene analyzer isolates malformed/provider failures and preserves successful scenes', async () => {
  const jobId = uuid(1);
  try {
    const scenes = [];
    for (let index = 1; index <= 2; index++) {
      const sceneId = `scene_${String(index).padStart(3, '0')}`;
      await artifactStore.initializeScene(jobId, sceneId);
      const keyframeId = `kf_${String(index).padStart(3, '0')}_01`;
      const keyframePath = path.join(artifactStore.keyframeDir(jobId, sceneId), `${keyframeId}.png`);
      await sharp({ create: { width: 80, height: 60, channels: 3, background: index === 1 ? '#3355aa' : '#aa5533' } })
        .png()
        .toFile(keyframePath);
      scenes.push({
        sceneId,
        start: index - 1,
        end: index,
        previewKeyframeId: keyframeId,
        keyframes: [{
          keyframeId,
          timestamp: index - 0.5,
          selectionReason: ['scene_midpoint'],
          sharpness: 100,
          motion: 0,
          path: keyframePath,
        }],
        elements: [],
      });
    }
    const provider = {
      analyzeScene: async (scene) => {
        if (scene.sceneId === 'scene_002') throw new Error('provider timeout');
        return {
          input: {
            summary: '<untrusted summary>',
            elements: [{
              type: 'screenshot',
              description: '<b>safe text</b>',
              extractability: 'direct',
              semanticConfidence: 0.9,
              localizationConfidence: 0.9,
              observations: [{
                keyframeRef: 0,
                bbox: [0.1, 0.1, 0.8, 0.8],
                visibility: 1,
                occlusion: 0,
                motion: 0,
              }],
            }],
          },
          audit: { provider: 'mock', model: 'v1', requestId: 'internal-only' },
        };
      },
    };
    const result = await sceneAnalysis.analyzeScenes(jobId, scenes, null, { provider, retries: 0 });
    assert.equal(result.failures.length, 1);
    assert.equal(result.scenes[0].analysis.status, 'complete');
    assert.equal(result.scenes[0].elements.length, 1);
    assert.equal(result.scenes[1].analysis.status, 'failed');
    assert.deepEqual(result.scenes[1].elements, []);
    const analysis = JSON.parse(
      await fs.promises.readFile(path.join(artifactStore.sceneDir(jobId, 'scene_001'), 'analysis.json'), 'utf8')
    );
    assert.equal(analysis.schemaVersion, 2);
    assert.equal(analysis.elements[0].observations.length, 1);
  } finally {
    await cleanup(jobId);
  }
});
