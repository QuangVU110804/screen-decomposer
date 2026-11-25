'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const test = require('node:test');
const express = require('express');
const sharp = require('sharp');
const config = require('../src/config');
const decomposerRoutes = require('../src/routes/decomposerRoutes');
const { createDecomposerJob, updateJob, getJob, removeJob } = require('../src/services/jobService');

function uuid(seed) {
  return `20000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

async function listen() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2', decomposerRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('scene-first API filters assets, serves allowlisted media and creates scoped ZIPs', async () => {
  const jobId = uuid(1);
  const packRoot = path.join(config.ASSET_DIR, jobId);
  const sceneRoot = path.join(packRoot, 'scene_001');
  const keyframeRoot = path.join(sceneRoot, 'keyframes');
  const assetRoot = path.join(sceneRoot, 'assets');
  await fs.promises.mkdir(keyframeRoot, { recursive: true });
  await fs.promises.mkdir(assetRoot, { recursive: true });
  const previewPath = path.join(sceneRoot, 'scene_preview.jpg');
  const keyframePath = path.join(keyframeRoot, 'kf_001_01.png');
  const primaryPath = path.join(assetRoot, 'screenshot_001.png');
  const thumbPath = path.join(assetRoot, 'screenshot_001_thumb.jpg');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#336699' } }).jpeg().toFile(previewPath);
  await sharp(previewPath).png().toFile(keyframePath);
  await fs.promises.copyFile(keyframePath, primaryPath);
  await sharp(primaryPath).resize({ width: 80 }).jpeg().toFile(thumbPath);
  await fs.promises.writeFile(path.join(packRoot, 'manifest.json'), '{"schemaVersion":2}', 'utf8');
  await fs.promises.writeFile(path.join(sceneRoot, 'metadata.json'), '{"sceneId":"scene_001"}', 'utf8');

  const element = {
    elementId: 'element_001_01',
    trackId: 'track_001',
    type: 'screenshot',
    description: 'API screenshot',
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
  const job = createDecomposerJob(jobId, { sourceType: 'upload' });
  updateJob(job.id, {
    status: 'done',
    stage: 'done',
    progress: 100,
    video: { duration: 2, width: 120, height: 80, fps: 25 },
    scenes: [{
      sceneId: 'scene_001',
      start: 0,
      end: 2,
      boundaryIn: { type: 'video_start', confidence: 1 },
      boundaryOut: { type: 'video_end', confidence: 1 },
      previewKeyframeId: 'kf_001_01',
      previewPath,
      keyframes: [{
        keyframeId: 'kf_001_01',
        timestamp: 1,
        selectionReason: ['scene_midpoint'],
        sharpness: 100,
        motion: 0,
        path: keyframePath,
      }],
      elements: [element],
      metrics: {},
      analysis: { status: 'complete', provider: { provider: 'mock', model: 'test', requestId: 'private-audit' } },
    }],
    tracks: [{
      trackId: 'track_001',
      type: 'screenshot',
      description: 'API screenshot',
      occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
    }],
    assets: [{
      assetId: 'asset_001',
      type: 'screenshot',
      description: 'API screenshot',
      extractionMode: 'DIRECT',
      quality: 0.9,
      qualityState: 'usable',
      qualityComponents: { resolution: 1 },
      sourcePixelsRatio: 1,
      reconstructedAreaRatio: 0,
      width: 120,
      height: 80,
      source: {
        sceneId: 'scene_001',
        elementId: 'element_001_01',
        keyframeId: 'kf_001_01',
        timestamp: 1,
        bbox: [0, 0, 1, 1],
      },
      occurrences: [{ sceneId: 'scene_001', elementId: 'element_001_01' }],
      files: { primary: primaryPath, thumbnail: thumbPath, mask: null, reconstructedMask: null },
    }],
    failures: [],
    assetCount: 1,
    sceneCount: 1,
  });

  const { server, base } = await listen();
  try {
    const configResponse = await fetch(`${base}/api/v2/config`);
    assert.equal(configResponse.status, 200);
    const publicConfig = await configResponse.json();
    assert.equal(publicConfig.schemaVersion, 2);
    assert.equal(JSON.stringify(publicConfig).includes('API_KEY'), false);

    const detailResponse = await fetch(`${base}/api/v2/jobs/${jobId}`);
    assert.equal(detailResponse.status, 200);
    const detailText = await detailResponse.text();
    assert.equal(detailText.includes('private-audit'), false);
    assert.equal(detailText.includes('previewPath'), false);
    assert.equal(detailText.includes('D:\\\\'), false);

    const sceneResponse = await fetch(`${base}/api/v2/jobs/${jobId}/scenes/scene_001`);
    const scene = await sceneResponse.json();
    assert.equal(scene.assets.length, 1);
    assert.equal(scene.keyframes[0].selectionReason[0], 'scene_midpoint');

    const assetsResponse = await fetch(`${base}/api/v2/jobs/${jobId}/assets?type=screenshot&mode=DIRECT&minQuality=0.8`);
    const assets = await assetsResponse.json();
    assert.equal(assets.count, 1);
    assert.match(assets.assets[0].files.primaryUrl, /\/media\/asset\/asset_001\/primary$/);
    assert.equal((await fetch(`${base}/api/v2/jobs/${jobId}/assets?type=bad-type`)).status, 400);

    const media = await fetch(`${base}${assets.assets[0].files.primaryUrl}`);
    assert.equal(media.status, 200);
    assert.match(media.headers.get('content-type'), /image\/png/);
    assert.equal((await fetch(`${base}/api/v2/jobs/${jobId}/media/asset/asset_001/unknown`)).status, 400);

    const sceneZip = await fetch(`${base}/api/v2/jobs/${jobId}/scenes/scene_001/download`);
    assert.equal(sceneZip.status, 200);
    const sceneBytes = Buffer.from(await sceneZip.arrayBuffer());
    assert.ok(sceneBytes.includes(Buffer.from('metadata.json')));
    assert.ok(sceneBytes.includes(Buffer.from('screenshot_001.png')));

    const fullZip = await fetch(`${base}/api/v2/jobs/${jobId}/download`);
    assert.equal(fullZip.status, 200);
    const fullBytes = Buffer.from(await fullZip.arrayBuffer());
    assert.ok(fullBytes.includes(Buffer.from('manifest.json')));

    const feedback = await fetch(`${base}/api/v2/jobs/${jobId}/assets/asset_001/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewerId: 'editor_api',
        downloaded: true,
        useful: true,
        timeSavedMinutes: 7,
        artifactRating: 4,
        comment: 'Useful clean crop',
      }),
    });
    assert.equal(feedback.status, 201);
    const feedbackBody = await feedback.json();
    assert.equal(feedbackBody.ok, true);
    assert.equal(feedbackBody.feedbackId, feedbackBody.feedback.feedbackId);
    assert.deepEqual(
      {
        reviewerId: feedbackBody.feedback.reviewerId,
        assetId: feedbackBody.feedback.assetId,
        type: feedbackBody.feedback.type,
        extractionMode: feedbackBody.feedback.extractionMode,
        useful: feedbackBody.feedback.useful,
        downloaded: feedbackBody.feedback.downloaded,
        timeSavedMinutes: feedbackBody.feedback.timeSavedMinutes,
        artifactRating: feedbackBody.feedback.artifactRating,
        comment: feedbackBody.feedback.comment,
      },
      {
        reviewerId: 'editor_api',
        assetId: 'asset_001',
        type: 'screenshot',
        extractionMode: 'DIRECT',
        useful: true,
        downloaded: true,
        timeSavedMinutes: 7,
        artifactRating: 4,
        comment: 'Useful clean crop',
      }
    );
    assert.equal(getJob(jobId).feedback.length, 1);

    const invalidReviewer = await fetch(`${base}/api/v2/jobs/${jobId}/assets/asset_001/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewerId: 'invalid reviewer!', useful: true }),
    });
    assert.equal(invalidReviewer.status, 400);

    const invalidRating = await fetch(`${base}/api/v2/jobs/${jobId}/assets/asset_001/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useful: true, artifactRating: 6 }),
    });
    assert.equal(invalidRating.status, 400);
    assert.equal(getJob(jobId).feedback.length, 1);

    const feedbackSummary = await fetch(`${base}/api/v2/jobs/${jobId}/feedback`);
    assert.equal(feedbackSummary.status, 200);
    const feedbackReport = await feedbackSummary.json();
    assert.equal(feedbackReport.jobId, jobId);
    assert.equal(feedbackReport.feedback.length, 1);
    assert.equal(feedbackReport.feedback[0].reviewerId, 'editor_api');
    assert.equal(feedbackReport.summary.eventCount, 1);
    assert.equal(feedbackReport.summary.reviewedAssetCount, 1);
    assert.equal(feedbackReport.summary.byType.screenshot.usefulRate, 1);
    assert.equal(feedbackReport.summary.byMode.DIRECT.downloadIntentRate, 1);
    assert.equal(feedbackReport.summary.gate.passed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeJob(jobId);
    await fs.promises.rm(packRoot, { recursive: true, force: true });
  }
});
