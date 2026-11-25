// Mounted at '/' in server.js. API paths keep their /api prefix here, while
// image paths are intentionally served at /assets/<jobId>/<filename>.
const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { getJob, listJobs } = require('../services/jobService');
const { serializeAsset, serializeJobSummary, serializeSceneClip } = require('../utils/serialize');

const router = express.Router();
const ASSET_FILE_RE = /^asset_\d{3}(_thumb|_clip|_clip_poster)?\.(png|jpg|mp4)$/;
const SCENE_CLIP_RE = /^clip_scene_\d{3}(_poster)?\.(mp4|jpg)$/;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/assets/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  if (!JOB_ID_RE.test(jobId) || (!ASSET_FILE_RE.test(filename) && !SCENE_CLIP_RE.test(filename))) {
    return res.status(400).json({ error: 'Tên file hoặc jobId không hợp lệ' });
  }

  const assetRoot = path.resolve(config.ASSET_DIR);
  const dir = path.resolve(assetRoot, jobId);
  const filePath = path.resolve(dir, filename);
  if (!filePath.startsWith(`${assetRoot}${path.sep}`)) {
    return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy file' });
  return res.sendFile(filePath, { maxAge: '1h' });
});

// Raw traversal paths can have too many segments to match the exact route;
// keep malformed /assets requests a deliberate 400 instead of a generic 404.
router.use('/assets', (_req, res) => (
  res.status(400).json({ error: 'Tên file hoặc jobId không hợp lệ' })
));

router.get('/api/jobs/:id/assets', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'Job chưa xong', status: job.status, progress: job.progress });
  }
  const assets = (job.assets || []).map((asset) => serializeAsset(job.id, asset));
  const sceneClips = (job.sceneClips || []).map((clip) => serializeSceneClip(job.id, clip));
  return res.json({ jobId: job.id, count: assets.length, assets, sceneClips });
});

router.get('/api/jobs/:id/download', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job chưa xong', status: job.status });

  const dir = path.join(config.ASSET_DIR, String(job.id));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: 'Không còn file (có thể đã bị dọn)' });
  }

  res.attachment(`${job.id}-assets.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('[zip] warning:', err.message));
  archive.on('error', (err) => {
    console.error('[zip] error:', err.message);
    res.destroy(err);
  });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
  return undefined;
});

router.get('/api/jobs', (req, res) => {
  const jobs = listJobs()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(serializeJobSummary);
  res.json({ jobs });
});

router.get('/api/config', (req, res) => {
  res.json({
    maxUploadMb: config.MAX_UPLOAD_MB,
    maxDurationSec: config.MAX_VIDEO_DURATION_SEC,
    allowedExtensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'],
    authRequired: Boolean(config.API_KEY),
  });
});

module.exports = router;
