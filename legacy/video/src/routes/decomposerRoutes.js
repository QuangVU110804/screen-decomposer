'use strict';

const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJob, updateJob } = require('../services/jobService');
const pipelineQueue = require('../services/pipelineQueue');
const pipelineService = require('../pipeline/pipelineService');
const { normalizeFeedback, summarizeFeedback } = require('../services/feedbackService');
const { rateLimit, requireApiKey } = require('../middleware/security');
const {
  serializeV2Job,
  serializeV2Scene,
  serializeV2SceneSummary,
  serializeV2Asset,
} = require('../utils/serialize');

const router = express.Router();
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCENE_ID_RE = /^scene_\d{3,}$/;
const ASSET_ID_RE = /^asset_\d{3,}$/;
const KEYFRAME_ID_RE = /^kf_\d{3,}_\d{2,}$/;
const READY = new Set(['done', 'partial']);

function v2Job(req, res) {
  if (!JOB_ID_RE.test(req.params.id || '')) {
    res.status(400).json({ error: 'jobId không hợp lệ' });
    return null;
  }
  const job = getJob(req.params.id);
  if (!job || Number(job.schemaVersion) !== 2) {
    res.status(404).json({ error: 'Không tìm thấy job decomposer v2' });
    return null;
  }
  return job;
}

function assertReady(job, res) {
  if (READY.has(job.status)) return true;
  res.status(409).json({ error: 'Job chưa đóng gói xong', status: job.status, progress: job.progress });
  return false;
}

function sendArchive(res, directory, filename) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return res.status(404).json({ error: 'Không còn asset pack (có thể đã bị cleanup)' });
  }
  res.attachment(filename);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (error) => console.warn('[v2 zip] warning:', error.message));
  archive.on('error', (error) => res.destroy(error));
  archive.pipe(res);
  archive.directory(directory, false);
  archive.finalize();
  return undefined;
}

router.get('/config', (_req, res) => res.json(config.publicConfig()));

router.get('/jobs/:id', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  res.json(serializeV2Job(job));
});

router.get('/jobs/:id/scenes', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  res.json({
    jobId: job.id,
    count: job.scenes?.length || 0,
    scenes: (job.scenes || []).map((scene) => serializeV2SceneSummary(job.id, scene)),
  });
});

router.get('/jobs/:id/scenes/:sceneId', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  if (!SCENE_ID_RE.test(req.params.sceneId || '')) return res.status(400).json({ error: 'sceneId không hợp lệ' });
  const scene = job.scenes?.find((item) => item.sceneId === req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Không tìm thấy scene' });
  return res.json(serializeV2Scene(job, scene));
});

router.get('/jobs/:id/assets', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  const allowedTypes = new Set([
    'person', 'character', 'background', 'image', 'screenshot', 'text',
    'graphic', 'logo', 'object', 'overlay', 'unknown',
  ]);
  const allowedModes = new Set(['DIRECT', 'SEGMENTED', 'RECONSTRUCTED', 'FAILED']);
  const type = req.query.type ? String(req.query.type) : null;
  const mode = req.query.mode ? String(req.query.mode).toUpperCase() : null;
  const includeFailed = String(req.query.includeFailed || '').toLowerCase() === 'true';
  const minQuality = req.query.minQuality === undefined ? 0 : Number(req.query.minQuality);
  if (type && !allowedTypes.has(type)) return res.status(400).json({ error: 'type không hợp lệ' });
  if (mode && !allowedModes.has(mode)) return res.status(400).json({ error: 'mode không hợp lệ' });
  if (!Number.isFinite(minQuality) || minQuality < 0 || minQuality > 1) {
    return res.status(400).json({ error: 'minQuality phải từ 0 đến 1' });
  }
  const assets = (job.assets || [])
    .filter((asset) => includeFailed || asset.qualityState !== 'failed')
    .filter((asset) => !type || asset.type === type)
    .filter((asset) => !mode || asset.extractionMode === mode)
    .filter((asset) => Number(asset.quality || 0) >= minQuality)
    .sort((left, right) => Number(right.quality || 0) - Number(left.quality || 0))
    .map((asset) => serializeV2Asset(job.id, asset));
  return res.json({ jobId: job.id, count: assets.length, assets });
});

router.get('/jobs/:id/media/:kind/:entityId/:variant', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  const { kind, entityId, variant } = req.params;
  let filePath = null;
  if (kind === 'asset' && ASSET_ID_RE.test(entityId)) {
    const allowed = new Set(['primary', 'thumbnail', 'mask', 'rawMask', 'reconstructedMask']);
    if (!allowed.has(variant)) return res.status(400).json({ error: 'Asset variant không hợp lệ' });
    filePath = job.assets?.find((asset) => asset.assetId === entityId)?.files?.[variant] || null;
  } else if (kind === 'scene' && SCENE_ID_RE.test(entityId) && variant === 'preview') {
    filePath = job.scenes?.find((scene) => scene.sceneId === entityId)?.previewPath || null;
  } else if (kind === 'keyframe' && KEYFRAME_ID_RE.test(entityId) && variant === 'frame') {
    for (const scene of job.scenes || []) {
      const keyframe = scene.keyframes?.find((item) => item.keyframeId === entityId);
      if (keyframe) { filePath = keyframe.path; break; }
    }
  } else {
    return res.status(400).json({ error: 'Media ID hoặc variant không hợp lệ' });
  }
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy media' });
  const resolved = path.resolve(filePath);
  const roots = [
    path.resolve(config.ASSET_DIR, job.id),
    path.resolve(config.JOB_DIR, job.id),
  ];
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    return res.status(400).json({ error: 'Media path nằm ngoài job allowlist' });
  }
  return res.sendFile(resolved, { maxAge: '1h' });
});

router.get('/jobs/:id/scenes/:sceneId/download', (req, res) => {
  const job = v2Job(req, res);
  if (!job || !assertReady(job, res)) return;
  if (!SCENE_ID_RE.test(req.params.sceneId || '') ||
      !job.scenes?.some((scene) => scene.sceneId === req.params.sceneId)) {
    return res.status(404).json({ error: 'Không tìm thấy scene' });
  }
  return sendArchive(
    res,
    path.join(config.ASSET_DIR, job.id, req.params.sceneId),
    `${job.id}-${req.params.sceneId}.zip`
  );
});

router.get('/jobs/:id/download', (req, res) => {
  const job = v2Job(req, res);
  if (!job || !assertReady(job, res)) return;
  return sendArchive(res, path.join(config.ASSET_DIR, job.id), `${job.id}-video-asset-pack.zip`);
});

router.post('/jobs/:id/assets/:assetId/feedback', requireApiKey, rateLimit, (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  const asset = job.assets?.find((item) => item.assetId === req.params.assetId);
  if (!ASSET_ID_RE.test(req.params.assetId || '') || !asset) {
    return res.status(404).json({ error: 'Không tìm thấy asset' });
  }
  let entry;
  try {
    entry = normalizeFeedback(asset, req.body || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const feedback = [
    ...(job.feedback || []),
    entry,
  ];
  updateJob(job.id, { feedback });
  return res.status(201).json({
    ok: true,
    feedbackId: entry.feedbackId,
    feedback: entry,
  });
});

router.get('/jobs/:id/feedback', (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  const feedback = job.feedback || [];
  return res.json({
    jobId: job.id,
    feedback,
    summary: summarizeFeedback(feedback, job.assets || []),
  });
});

router.post('/jobs/:id/scenes/:sceneId/reanalyze', requireApiKey, rateLimit, (req, res) => {
  const job = v2Job(req, res);
  if (!job) return;
  if (!SCENE_ID_RE.test(req.params.sceneId || '') ||
      !job.scenes?.some((scene) => scene.sceneId === req.params.sceneId)) {
    return res.status(404).json({ error: 'Không tìm thấy scene' });
  }
  try {
    const queued = pipelineQueue.enqueue(job.id, () => pipelineService.reanalyzeScene(job.id, req.params.sceneId));
    return res.status(202).json({ jobId: job.id, sceneId: req.params.sceneId, queued: queued.queued });
  } catch (error) {
    return res.status(error.code === 'QUEUE_FULL' ? 429 : 500).json({ error: error.message });
  }
});

module.exports = router;
