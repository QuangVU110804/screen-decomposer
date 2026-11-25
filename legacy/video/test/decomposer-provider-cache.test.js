'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');
const config = require('../src/config');
const artifactStore = require('../src/services/artifactStore');
const segmentation = require('../src/services/segmentationService');
const backgroundRecovery = require('../src/services/backgroundRecoveryService');

function uuid(seed) {
  return `70000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

async function cleanup(jobId) {
  await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
}

function keyframeScene(imagePath, element, keyframes = null) {
  return {
    sceneId: 'scene_001',
    start: 0,
    end: 2,
    previewKeyframeId: 'kf_001_01',
    keyframes: keyframes || [{
      keyframeId: 'kf_001_01',
      timestamp: 1,
      selectionReason: ['scene_midpoint'],
      sharpness: 200,
      motion: 0,
      path: imagePath,
    }],
    elements: [element],
  };
}

test('segmentation cache survives asset-directory rebuild and is keyed by provider version', async () => {
  const jobId = uuid(1);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const imagePath = path.join(
      artifactStore.keyframeDir(jobId, 'scene_001'),
      'kf_001_01.png'
    );
    await sharp({
      create: { width: 80, height: 80, channels: 3, background: '#ffffff' },
    }).composite([{
      input: { create: { width: 40, height: 50, channels: 3, background: '#cc2233' } },
      left: 20,
      top: 15,
    }]).png().toFile(imagePath);
    const element = {
      elementId: 'element_001_01',
      type: 'character',
      description: 'Cached character',
      extractability: 'segmentable',
      semanticConfidence: 0.9,
      localizationConfidence: 0.9,
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 1,
        occlusion: 0,
        motion: 0,
      }],
      assetIds: [],
    };
    const scene = keyframeScene(imagePath, element);
    let calls = 0;
    const provider = {
      name: 'fixture-segmenter',
      version: '1',
      segment: async ({ width, height }) => {
        calls++;
        const mask = Buffer.alloc(width * height);
        for (let y = 15; y < 65; y++) {
          for (let x = 20; x < 60; x++) mask[y * width + x] = 255;
        }
        return {
          rawMask: mask,
          mask,
          confidence: 0.95,
          provider: { name: 'fixture-segmenter', version: '1' },
        };
      },
    };
    const first = await segmentation.segmentOne(jobId, scene, element, 'asset_001', { provider });
    assert.equal(calls, 1);
    assert.equal(first.segmentation.cacheHit, false);
    await fs.promises.rm(artifactStore.assetDir(jobId, 'scene_001'), { recursive: true, force: true });
    await fs.promises.mkdir(artifactStore.assetDir(jobId, 'scene_001'), { recursive: true });
    const second = await segmentation.segmentOne(jobId, scene, element, 'asset_001', { provider });
    assert.equal(calls, 1);
    assert.equal(second.segmentation.cacheHit, true);
    assert.ok(fs.existsSync(second.files.primary));
    assert.ok(fs.existsSync(second.files.rawMask));

    await segmentation.segmentOne(jobId, scene, element, 'asset_001', {
      provider: { ...provider, version: '2' },
    });
    assert.equal(calls, 2);
  } finally {
    await cleanup(jobId);
  }
});

test('inpainting cache avoids a second provider call when local asset outputs are rebuilt', async () => {
  const jobId = uuid(2);
  const previousEnabled = config.ENABLE_BACKGROUND_RECOVERY;
  try {
    config.ENABLE_BACKGROUND_RECOVERY = true;
    await artifactStore.initializeScene(jobId, 'scene_001');
    const imagePath = path.join(
      artifactStore.keyframeDir(jobId, 'scene_001'),
      'kf_001_01.png'
    );
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#224466' },
    }).png().toFile(imagePath);
    const maskPath = path.join(artifactStore.maskDir(jobId, 'scene_001'), 'foreground.png');
    await sharp({
      create: { width: 20, height: 30, channels: 3, background: '#ffffff' },
    }).grayscale().png().toFile(maskPath);
    const element = {
      elementId: 'element_001_02',
      type: 'background',
      description: 'Cached background',
      extractability: 'requires_inpainting',
      semanticConfidence: 0.9,
      localizationConfidence: 0.9,
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 0.8,
        occlusion: 0.2,
        motion: 0.5,
      }],
      assetIds: [],
    };
    const scene = keyframeScene(imagePath, element);
    scene.keyframes[0].motion = 0.5;
    const foregroundAssets = [{
      extractionMode: 'SEGMENTED',
      source: {
        sceneId: 'scene_001',
        cropTransform: { left: 10, top: 10, width: 20, height: 30 },
      },
      files: { mask: maskPath },
    }];
    let calls = 0;
    const provider = {
      name: 'fixture-inpainter',
      version: '1',
      inpaint: async ({ imageBuffer, maskBuffer, width, height }) => {
        calls++;
        return backgroundRecovery.localInpaint(imageBuffer, maskBuffer, width, height);
      },
    };
    const first = await backgroundRecovery.recoverOne(
      jobId,
      scene,
      element,
      foregroundAssets,
      'asset_001',
      { provider }
    );
    assert.equal(calls, 1);
    assert.equal(first.reconstruction.cacheHit, false);
    await fs.promises.rm(artifactStore.assetDir(jobId, 'scene_001'), { recursive: true, force: true });
    await fs.promises.mkdir(artifactStore.assetDir(jobId, 'scene_001'), { recursive: true });
    const second = await backgroundRecovery.recoverOne(
      jobId,
      scene,
      element,
      foregroundAssets,
      'asset_001',
      { provider }
    );
    assert.equal(calls, 1);
    assert.equal(second.reconstruction.cacheHit, true);
    assert.ok(fs.existsSync(second.files.primary));
  } finally {
    config.ENABLE_BACKGROUND_RECOVERY = previousEnabled;
    await cleanup(jobId);
  }
});
