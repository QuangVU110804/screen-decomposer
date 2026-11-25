'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');
const config = require('../src/config');
const artifactStore = require('../src/services/artifactStore');
const schema = require('../src/domain/decomposerSchema');
const segmentation = require('../src/services/segmentationService');
const backgroundRecovery = require('../src/services/backgroundRecoveryService');
const quality = require('../src/services/assetQualityService');
const dedupe = require('../src/services/assetDeduplicationService');
const packageService = require('../src/services/packageService');
const ocrService = require('../src/services/ocrService');
const embeddingService = require('../src/services/embeddingService');
const { ProviderRegistry } = require('../src/domain/providerContracts');
const {
  makeThumbnail,
  rectifyQuadrilateral,
  extractDirectAssets,
} = require('../src/services/directExtractionService');
const { serializeV2Job } = require('../src/utils/serialize');
const {
  binaryMaskMetrics,
  binaryMaskBoundaryMetrics,
} = require('../scripts/evaluate-decomposer');

function uuid(seed) {
  return `10000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function sceneWithKeyframe(sceneId, keyframePath, element) {
  const number = sceneId.slice(6);
  return {
    sceneId,
    start: 0,
    end: 2,
    boundaryIn: { type: 'video_start', confidence: 1 },
    boundaryOut: { type: 'video_end', confidence: 1 },
    previewKeyframeId: `kf_${number}_01`,
    previewPath: keyframePath,
    keyframes: [{
      keyframeId: `kf_${number}_01`,
      timestamp: 1,
      selectionReason: ['scene_midpoint'],
      sharpness: 250,
      motion: 0,
      path: keyframePath,
    }],
    elements: element ? [element] : [],
    metrics: {},
  };
}

async function cleanupJob(jobId) {
  await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
}

test('schema v2 enforces canonical partitions, keyframe reasons and bounded bboxes', () => {
  const sceneA = {
    sceneId: 'scene_001',
    start: 0,
    end: 1,
    previewKeyframeId: 'kf_001_01',
    keyframes: [{
      keyframeId: 'kf_001_01',
      timestamp: 0.5,
      selectionReason: ['scene_midpoint'],
      path: 'internal',
    }],
    elements: [],
  };
  const sceneB = {
    sceneId: 'scene_002',
    start: 1,
    end: 2,
    previewKeyframeId: 'kf_002_01',
    keyframes: [{
      keyframeId: 'kf_002_01',
      timestamp: 1.5,
      selectionReason: ['scene_midpoint'],
      path: 'internal',
    }],
    elements: [],
  };
  assert.doesNotThrow(() => schema.validateManifest({
    schemaVersion: 2,
    video: { duration: 2 },
    scenes: [sceneA, sceneB],
    tracks: [],
    assets: [],
  }, { requireKeyframes: true }));
  assert.throws(
    () => schema.validateScenes([{ ...sceneA }, { ...sceneB, start: 1.2 }], 2),
    /gap or overlap/
  );
  assert.throws(() => schema.validateBbox([0.8, 0.1, 0.3, 0.2]), /stay inside/);
  const segmented = {
    assetId: 'asset_001',
    type: 'character',
    extractionMode: 'SEGMENTED',
    sourcePixelsRatio: 0.9,
    reconstructedAreaRatio: 0,
    occurrences: [{ sceneId: 'scene_001' }],
  };
  assert.throws(
    () => schema.validateAssets([segmented], [sceneA, sceneB]),
    /SEGMENTED must isolate source pixels/
  );
  const reconstructed = {
    assetId: 'asset_002',
    type: 'background',
    extractionMode: 'RECONSTRUCTED',
    sourcePixelsRatio: 0.8,
    reconstructedAreaRatio: 0.2,
    recoveryAreaRatio: 0.2,
    reconstruction: { provider: { name: 'test', version: '1' } },
    occurrences: [{ sceneId: 'scene_001' }],
    files: {},
  };
  assert.throws(
    () => schema.validateAssets([reconstructed], [sceneA, sceneB]),
    /reconstruction mask/
  );
  const trackedScene = {
    ...sceneA,
    elements: [{
      elementId: 'element_001_01',
      trackId: 'track_001',
      type: 'screenshot',
      description: 'Tracked screenshot',
      extractability: 'direct',
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 1,
        occlusion: 0,
        motion: 0,
      }],
      assetIds: [],
    }],
  };
  assert.throws(
    () => schema.validateManifest({
      schemaVersion: 2,
      video: { duration: 1 },
      scenes: [trackedScene],
      tracks: [],
      assets: [],
    }, { requireKeyframes: true }),
    /unknown track/
  );
  assert.throws(
    () => schema.validateManifest({
      schemaVersion: 2,
      video: { duration: 1 },
      scenes: [trackedScene],
      tracks: [{
        trackId: 'track_001',
        type: 'screenshot',
        occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
      }],
      assets: [{
        assetId: 'asset_001',
        type: 'screenshot',
        extractionMode: 'DIRECT',
        sourcePixelsRatio: 1,
        reconstructedAreaRatio: 0,
        occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
      }],
    }, { requireKeyframes: true }),
    /assetIds is missing/
  );
});

test('provider contracts reject malformed adapters and OCR failure falls back without failing the asset', async () => {
  assert.throws(
    () => new ProviderRegistry({ Segmenter: { notSegment: async () => {} } }),
    /must implement segment/
  );
  const registry = new ProviderRegistry({
    Segmenter: { segment: async () => ({ mask: Buffer.alloc(1) }) },
  });
  assert.equal(typeof registry.get('Segmenter').segment, 'function');
  const text = await ocrService.recognizeElement({
    text: 'VISIBLE TEXT',
    semanticConfidence: 0.88,
    textStyle: { weight: 'bold' },
  }, {}, {
    provider: { recognize: async () => { throw new Error('OCR unavailable'); } },
  });
  assert.equal(text.content, 'VISIBLE TEXT');
  assert.equal(text.fallback, true);
  assert.match(text.error, /OCR unavailable/);
  const identical = embeddingService.cosineSimilarity(
    embeddingService.localEmbedding('same visual element'),
    embeddingService.localEmbedding('same visual element')
  );
  assert.ok(identical > 0.999);
});

test('local segmentation creates a real RGBA asset and explainable quality', async () => {
  const jobId = uuid(1);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const keyframePath = path.join(artifactStore.keyframeDir(jobId, 'scene_001'), 'kf_001_01.png');
    const redSquare = await sharp({
      create: { width: 120, height: 120, channels: 3, background: '#ffffff' },
    }).composite([{
      input: {
        create: { width: 64, height: 84, channels: 3, background: '#dd2233' },
      },
      left: 28,
      top: 18,
    }]).png().toBuffer();
    await fs.promises.writeFile(keyframePath, redSquare);
    const element = {
      elementId: 'element_001_01',
      trackId: 'track_001',
      type: 'character',
      description: 'Synthetic red character',
      extractability: 'segmentable',
      semanticConfidence: 0.9,
      localizationConfidence: 0.95,
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 1,
        occlusion: 0,
        motion: 0,
      }],
      assetIds: [],
    };
    const scene = sceneWithKeyframe('scene_001', keyframePath, element);
    const asset = await segmentation.segmentOne(jobId, scene, element, 'asset_001');
    assert.equal(asset.extractionMode, 'SEGMENTED');
    assert.ok(fs.existsSync(asset.files.primary));
    assert.ok(fs.existsSync(asset.files.mask));
    const metadata = await sharp(asset.files.primary).metadata();
    const stats = await sharp(asset.files.primary).stats();
    assert.equal(metadata.hasAlpha, true);
    assert.ok(stats.channels[3].min < 100);
    assert.ok(stats.channels[3].max > 200);
    const actualMask = await sharp(asset.files.mask).grayscale().raw().toBuffer();
    const expectedMask = Buffer.alloc(120 * 120);
    for (let y = 18; y < 102; y++) {
      for (let x = 28; x < 92; x++) expectedMask[y * 120 + x] = 255;
    }
    const maskMetrics = binaryMaskMetrics(expectedMask, actualMask);
    assert.ok(maskMetrics.iou > 0.9, `mask IoU was ${maskMetrics.iou}`);
    const boundaryMetrics = binaryMaskBoundaryMetrics(
      expectedMask,
      actualMask,
      120,
      120,
      { tolerancePx: 2 }
    );
    assert.ok(
      boundaryMetrics.f1 > 0.85,
      `mask boundary F1 was ${boundaryMetrics.f1}`
    );

    const scored = await quality.scoreAndValidateAssets([asset], [scene]);
    assert.equal(scored.failures.length, 0);
    assert.ok(asset.quality > 0);
    assert.ok(Object.hasOwn(asset.qualityComponents, 'mask'));
    assert.notEqual(asset.quality, element.semanticConfidence);
    const lowQuality = {
      ...asset,
      assetId: 'asset_099',
      width: 12,
      height: 12,
      segmentation: { ...asset.segmentation, confidence: 0.2, edgeContamination: 0.8 },
      source: { ...asset.source, keyframeId: 'kf_001_01' },
      occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
    };
    quality.scoreAsset(lowQuality, [scene]);
    assert.ok(asset.quality > lowQuality.quality);
  } finally {
    await cleanupJob(jobId);
  }
});

test('direct extraction can rectify a tilted quadrilateral without inventing pixels', async () => {
  const root = await fs.promises.mkdtemp(path.join(config.TEMP_DIR, 'perspective-v2-'));
  try {
    const source = path.join(root, 'tilted.png');
    await sharp({
      create: { width: 200, height: 120, channels: 3, background: '#17243a' },
    }).composite([{
      input: {
        create: { width: 120, height: 70, channels: 3, background: '#f4d35e' },
      },
      left: 40,
      top: 25,
    }]).png().toFile(source);
    const result = await rectifyQuadrilateral(source, [
      [0.2, 0.22],
      [0.78, 0.17],
      [0.82, 0.8],
      [0.18, 0.76],
    ]);
    const metadata = await sharp(result.buffer).metadata();
    assert.ok(metadata.width >= 110);
    assert.ok(metadata.height >= 65);
    assert.equal(result.transform.type, 'quadrilateral_rectification');

    const missingElement = {
      elementId: 'element_001_01',
      trackId: 'track_001',
      type: 'screenshot',
      description: 'Missing direct source',
      extractability: 'direct',
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 1,
        occlusion: 0,
        motion: 0,
      }],
      assetIds: [],
    };
    const missingScene = sceneWithKeyframe(
      'scene_001',
      path.join(root, 'missing-keyframe.png'),
      missingElement
    );
    const failed = await extractDirectAssets(uuid(91), [missingScene]);
    assert.equal(failed.assets.length, 1);
    assert.equal(failed.assets[0].extractionMode, 'FAILED');
    assert.equal(failed.assets[0].attemptedExtractionMode, 'DIRECT');
    assert.deepEqual(missingElement.assetIds, ['asset_001']);
    assert.equal(failed.failures[0].assetId, 'asset_001');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('dedupe combines true duplicates but chroma prevents flat-color false merges', async () => {
  const root = await fs.promises.mkdtemp(path.join(config.TEMP_DIR, 'dedupe-v2-'));
  try {
    const redA = path.join(root, 'red-a.png');
    const redB = path.join(root, 'red-b.png');
    const green = path.join(root, 'green.png');
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ff0000' } }).png().toFile(redA);
    await fs.promises.copyFile(redA, redB);
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#00ff00' } }).png().toFile(green);
    const scenes = [
      { sceneId: 'scene_001', elements: [{ elementId: 'element_001_01', assetIds: ['asset_001'] }] },
      { sceneId: 'scene_002', elements: [{ elementId: 'element_002_01', assetIds: ['asset_002'] }] },
      { sceneId: 'scene_003', elements: [{ elementId: 'element_003_01', assetIds: ['asset_003'] }] },
    ];
    const make = (assetId, sceneId, elementId, primary) => ({
      assetId,
      type: 'graphic',
      description: 'Synthetic color card',
      extractionMode: 'DIRECT',
      quality: 0.8,
      qualityState: 'usable',
      sourcePixelsRatio: 1,
      reconstructedAreaRatio: 0,
      width: 100,
      height: 80,
      source: { sceneId, elementId, trackId: 'track_001' },
      occurrences: [{ sceneId, elementId }],
      files: { primary },
    });
    const result = await dedupe.deduplicateAssets([
      make('asset_001', 'scene_001', 'element_001_01', redA),
      make('asset_002', 'scene_002', 'element_002_01', redB),
      make('asset_003', 'scene_003', 'element_003_01', green),
    ], scenes);
    assert.equal(result.assets.length, 2);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.assets[0].occurrences.length, 2);
    assert.deepEqual(scenes[1].elements[0].assetIds, ['asset_001']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('background recovery prefers real pixels from another keyframe and records the recovery mask', async () => {
  const jobId = uuid(3);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const firstPath = path.join(artifactStore.keyframeDir(jobId, 'scene_001'), 'kf_001_01.png');
    const secondPath = path.join(artifactStore.keyframeDir(jobId, 'scene_001'), 'kf_001_02.png');
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#224466' } })
      .composite([{ input: { create: { width: 24, height: 50, channels: 3, background: '#ff2222' } }, left: 20, top: 15 }])
      .png()
      .toFile(firstPath);
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#224466' } }).png().toFile(secondPath);
    const maskPath = path.join(artifactStore.maskDir(jobId, 'scene_001'), 'person-mask.png');
    await sharp({ create: { width: 24, height: 50, channels: 3, background: '#ffffff' } })
      .grayscale()
      .png()
      .toFile(maskPath);
    const backgroundElement = {
      elementId: 'element_001_02',
      trackId: 'track_002',
      type: 'background',
      description: 'Synthetic blue studio',
      extractability: 'requires_inpainting',
      semanticConfidence: 0.9,
      localizationConfidence: 0.9,
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 0.85,
        occlusion: 0.15,
        motion: 0,
      }],
      assetIds: [],
    };
    const scene = {
      ...sceneWithKeyframe('scene_001', firstPath, backgroundElement),
      keyframes: [
        {
          keyframeId: 'kf_001_01',
          timestamp: 0.5,
          selectionReason: ['scene_start'],
          sharpness: 100,
          motion: 0,
          path: firstPath,
        },
        {
          keyframeId: 'kf_001_02',
          timestamp: 1.5,
          selectionReason: ['scene_end'],
          sharpness: 100,
          motion: 0,
          path: secondPath,
        },
      ],
    };
    const foregroundAssets = [{
      extractionMode: 'SEGMENTED',
      source: {
        sceneId: 'scene_001',
        cropTransform: { left: 20, top: 15, width: 24, height: 50 },
      },
      files: { mask: maskPath },
    }];
    const recovered = await backgroundRecovery.recoverOne(
      jobId,
      scene,
      backgroundElement,
      foregroundAssets,
      'asset_002'
    );
    assert.equal(recovered.extractionMode, 'RECONSTRUCTED');
    assert.equal(recovered.reconstruction.generated, false);
    assert.equal(recovered.sourcePixelsRatio, 1);
    assert.equal(recovered.reconstructedAreaRatio, 0);
    assert.ok(recovered.recoveryAreaRatio > 0);
    assert.ok(Math.abs(recovered.recoveryAreaRatio - 0.15) < 0.01);
    assert.equal(
      recovered.reconstruction.alignment.method,
      'identity-outside-recovery-mask'
    );
    assert.ok(recovered.reconstruction.alignment.meanAbsoluteDifference < 1);
    assert.ok(fs.existsSync(recovered.files.reconstructedMask));
  } finally {
    await cleanupJob(jobId);
  }
});

test('v2 packager creates scene packs atomically and serializer leaks no paths', async () => {
  const jobId = uuid(2);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const keyframePath = path.join(artifactStore.keyframeDir(jobId, 'scene_001'), 'kf_001_01.png');
    const previewPath = path.join(artifactStore.sceneDir(jobId, 'scene_001'), 'preview.jpg');
    const primaryPath = path.join(artifactStore.assetDir(jobId, 'scene_001'), 'asset_001.png');
    const thumbPath = path.join(artifactStore.assetDir(jobId, 'scene_001'), 'asset_001_thumb.jpg');
    await sharp({ create: { width: 160, height: 90, channels: 3, background: '#3155aa' } }).png().toFile(keyframePath);
    await sharp(keyframePath).jpeg().toFile(previewPath);
    await fs.promises.copyFile(keyframePath, primaryPath);
    await makeThumbnail(primaryPath, thumbPath);
    const element = {
      elementId: 'element_001_01',
      trackId: 'track_001',
      type: 'screenshot',
      description: 'Synthetic screenshot',
      extractability: 'direct',
      semanticConfidence: 0.9,
      localizationConfidence: 0.9,
      observations: [{
        keyframeId: 'kf_001_01',
        bbox: [0, 0, 1, 1],
        visibility: 1,
        occlusion: 0,
        motion: 0,
      }],
      assetIds: ['asset_001'],
    };
    const scene = sceneWithKeyframe('scene_001', keyframePath, element);
    scene.previewPath = previewPath;
    scene.analysis = {
      status: 'failed',
      error: 'provider https://internal.example/analyze returned req_12345678 while reading D:\\private\\frame.png',
      provider: { provider: 'mock', model: 'unsafe-test' },
    };
    const asset = {
      assetId: 'asset_001',
      type: 'screenshot',
      description: 'Synthetic screenshot',
      extractionMode: 'DIRECT',
      quality: 0.9,
      qualityState: 'usable',
      qualityComponents: { resolution: 1 },
      sourcePixelsRatio: 1,
      reconstructedAreaRatio: 0,
      source: {
        sceneId: 'scene_001',
        elementId: 'element_001_01',
        trackId: 'track_001',
        keyframeId: 'kf_001_01',
        timestamp: 1,
        bbox: [0, 0, 1, 1],
      },
      width: 160,
      height: 90,
      occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
      files: { primary: primaryPath, thumbnail: thumbPath, mask: null, reconstructedMask: null },
    };
    const job = {
      id: jobId,
      schemaVersion: 2,
      resultType: 'decomposer',
      status: 'done',
      stage: 'done',
      progress: 100,
      video: { duration: 2, width: 160, height: 90, fps: 25 },
      scenes: [scene],
      tracks: [{
        trackId: 'track_001',
        type: 'screenshot',
        description: 'Synthetic screenshot',
        occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
      }],
      assets: [asset],
      failures: [{
        sceneId: 'scene_001',
        code: 'UNSAFE_PROVIDER_ERROR',
        message: 'open D:\\private\\secret.png with sk-ant-secretvalue and req_abcdefgh',
      }],
      metrics: {},
    };
    const packaged = await packageService.packageJob(job);
    assert.ok(fs.existsSync(path.join(packaged.outputDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(packaged.outputDir, 'scene_001', 'metadata.json')));
    assert.ok(fs.existsSync(path.join(packaged.outputDir, 'scene_001', 'assets', 'screenshot_001.png')));
    const sceneMetadata = JSON.parse(await fs.promises.readFile(
      path.join(packaged.outputDir, 'scene_001', 'metadata.json'),
      'utf8'
    ));
    assert.equal(sceneMetadata.assets.length, 1);
    assert.equal(sceneMetadata.assets[0].extractionMode, 'DIRECT');
    assert.equal(sceneMetadata.assets[0].sourcePixelsRatio, 1);
    assert.equal(sceneMetadata.assets[0].files.primary, 'assets/screenshot_001.png');
    assert.equal(sceneMetadata.assets[0].occurrences.length, 1);
    assert.match(sceneMetadata.notices.provenance, /RECONSTRUCTED/);
    assert.match(sceneMetadata.notices.copyright, /legal permission/);
    const manifestText = await fs.promises.readFile(path.join(packaged.outputDir, 'manifest.json'), 'utf8');
    assert.equal(manifestText.includes(config.ROOT || 'D:\\yt-frame-extractor'), false);
    assert.equal(manifestText.includes('API_KEY'), false);
    assert.equal(manifestText.includes('D:\\private'), false);
    assert.equal(manifestText.includes('sk-ant-'), false);
    assert.equal(manifestText.includes('internal.example'), false);
    assert.equal(manifestText.includes('req_12345678'), false);
    const serialized = JSON.stringify(serializeV2Job(job));
    assert.equal(serialized.includes('framePath'), false);
    assert.equal(serialized.includes('previewPath'), false);
    assert.equal(serialized.includes('D:\\\\'), false);
    assert.equal(serialized.includes('sk-ant-'), false);
    assert.equal(serialized.includes('internal.example'), false);
    assert.equal(serialized.includes('req_12345678'), false);

    const stablePrimaryPath = job.assets[0].files.primary;
    const markerPath = path.join(packaged.outputDir, 'previous-pack.marker');
    await fs.promises.writeFile(markerPath, 'previous valid pack', 'utf8');
    await assert.rejects(
      packageService.packageJob(job, {
        afterDirectoryCommit: async () => {
          throw new Error('deliberate post-commit packaging failure');
        },
      }),
      /deliberate post-commit packaging failure/
    );
    assert.equal(
      await fs.promises.readFile(path.join(packaged.outputDir, 'manifest.json'), 'utf8'),
      manifestText
    );
    assert.equal(await fs.promises.readFile(markerPath, 'utf8'), 'previous valid pack');
    assert.equal(job.assets[0].files.primary, stablePrimaryPath);
    assert.ok(fs.existsSync(stablePrimaryPath));
    const leftovers = (await fs.promises.readdir(config.ASSET_DIR)).filter((entry) => (
      entry.startsWith(`.staging-v2-${jobId}-`) ||
      entry.startsWith(`${jobId}.backup-`)
    ));
    assert.deepEqual(leftovers, []);
  } finally {
    await cleanupJob(jobId);
  }
});
