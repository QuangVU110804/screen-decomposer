'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const sharp = require('sharp');
const config = require('../src/config');
const artifactStore = require('../src/services/artifactStore');
const sceneAnalysis = require('../src/services/sceneAnalysisService');
const pipeline = require('../src/pipeline/pipelineService');

function uuid(seed) {
  return `60000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

async function cleanup(jobId) {
  await fs.promises.rm(path.join(config.JOB_DIR, jobId), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
}

test('scene analysis refuses an image payload that exceeds the per-scene byte budget', async () => {
  const jobId = uuid(1);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const imagePath = path.join(
      artifactStore.keyframeDir(jobId, 'scene_001'),
      'kf_001_01.png'
    );
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#3155aa' },
    }).png().toFile(imagePath);
    const scene = {
      sceneId: 'scene_001',
      start: 0,
      end: 1,
      keyframes: [{
        keyframeId: 'kf_001_01',
        timestamp: 0.5,
        selectionReason: ['scene_midpoint'],
        path: imagePath,
      }],
    };
    await assert.rejects(
      sceneAnalysis.buildContent(scene, { maxImageBytes: 1 }),
      (error) => (
        error.code === 'VISION_IMAGE_BUDGET_EXCEEDED' &&
        error.sceneId === 'scene_001' &&
        error.imageBytes > error.maxImageBytes
      )
    );
    const prepared = await sceneAnalysis.buildContent(scene, { maxImageBytes: 1024 * 1024 });
    assert.ok(prepared.bytes > 1);
    assert.equal(prepared.pixels, 80 * 60);
    assert.equal(prepared.content.filter((block) => block.type === 'image').length, 1);
    await assert.rejects(
      sceneAnalysis.buildContent(scene, {
        maxImageBytes: 1024 * 1024,
        maxImagePixels: 100,
      }),
      (error) => (
        error.code === 'VISION_PIXEL_BUDGET_EXCEEDED' &&
        error.imagePixels === 80 * 60
      )
    );
  } finally {
    await cleanup(jobId);
  }
});

test('resource guard records usage and rejects disk and runtime overruns with stable codes', async () => {
  const diskJobId = uuid(2);
  const runtimeJobId = uuid(3);
  try {
    await artifactStore.initialize(diskJobId);
    await fs.promises.writeFile(
      path.join(artifactStore.jobDir(diskJobId), 'budget.bin'),
      Buffer.alloc(32)
    );
    const diskJob = { id: diskJobId, metrics: {} };
    const diskGuard = pipeline.createResourceBudgetGuard(diskJob, Date.now(), {
      maxJobDiskBytes: 1,
      maxPipelineRuntimeMs: 60_000,
    });
    await assert.rejects(
      diskGuard.assertWithinBudget('probing', 'after'),
      (error) => error.code === 'JOB_DISK_BUDGET_EXCEEDED' && error.diskBytes >= 32
    );
    assert.ok(diskJob.metrics.resources.peakDiskBytes >= 32);
    assert.equal(diskJob.metrics.resources.lastCheckedStage, 'probing');

    const runtimeJob = { id: runtimeJobId, metrics: {} };
    const runtimeGuard = pipeline.createResourceBudgetGuard(runtimeJob, Date.now() - 100, {
      maxJobDiskBytes: 1024 * 1024,
      maxPipelineRuntimeMs: 1,
    });
    await assert.rejects(
      runtimeGuard.assertWithinBudget('detecting_scenes', 'before'),
      (error) => (
        error.code === 'PIPELINE_RUNTIME_BUDGET_EXCEEDED' &&
        error.elapsedMs > error.maxRuntimeMs
      )
    );
    assert.ok(runtimeJob.metrics.resources.elapsedMs >= 100);
  } finally {
    await cleanup(diskJobId);
    await cleanup(runtimeJobId);
  }
});

test('scene analysis audit records per-scene latency without exposing provider secrets', async () => {
  const jobId = uuid(4);
  try {
    await artifactStore.initializeScene(jobId, 'scene_001');
    const imagePath = path.join(
      artifactStore.keyframeDir(jobId, 'scene_001'),
      'kf_001_01.png'
    );
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#224466' },
    }).png().toFile(imagePath);
    const scene = {
      sceneId: 'scene_001',
      start: 0,
      end: 1,
      previewKeyframeId: 'kf_001_01',
      keyframes: [{
        keyframeId: 'kf_001_01',
        timestamp: 0.5,
        selectionReason: ['scene_midpoint'],
        path: imagePath,
      }],
      elements: [],
    };
    await sceneAnalysis.analyzeScene(jobId, scene, {
      retries: 0,
      provider: {
        analyzeScene: async () => ({
          input: { summary: 'No reusable elements', elements: [] },
          audit: { provider: 'mock', model: 'budget-test' },
        }),
      },
    });
    assert.equal(scene.analysis.provider.provider, 'mock');
    assert.equal(scene.analysis.provider.model, 'budget-test');
    assert.ok(Number.isFinite(scene.analysis.provider.latencyMs));
    const artifact = JSON.parse(
      await fs.promises.readFile(
        path.join(artifactStore.sceneDir(jobId, 'scene_001'), 'analysis.json'),
        'utf8'
      )
    );
    assert.ok(Number.isFinite(artifact.provider.latencyMs));
    assert.equal(JSON.stringify(artifact).includes('ANTHROPIC_API_KEY'), false);
  } finally {
    await cleanup(jobId);
  }
});
