const express = require('express');
const { randomUUID } = require('crypto');

const { createDecomposerJob, updateJob, getJob, removeJob } = require('../services/jobService');
const { downloadVideo } = require('../services/downloadService');
const ingestion = require('../services/ingestionService');
const { upload, removeTempUpload } = require('../middleware/upload');
const pipelineQueue = require('../services/pipelineQueue');
const pipelineService = require('../pipeline/pipelineService');
const legacyPipelineService = require('../pipeline/legacyPipelineService');
const { serializeJob } = require('../utils/serialize');
const { rateLimit, requireApiKey } = require('../middleware/security');
const { MAX_UPLOAD_MB } = require('../config');

const router = express.Router();

router.post('/extract', requireApiKey, rateLimit, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Thiếu url' });

  let normalizedUrl;
  try {
    normalizedUrl = ingestion.resolveYoutube(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const jobId = randomUUID();
  createDecomposerJob(jobId, { sourceType: 'youtube', sourceUrl: normalizedUrl });
  try {
    pipelineQueue.enqueue(jobId, () => runUrl(jobId, normalizedUrl));
  } catch (err) {
    removeJob(jobId);
    if (err.code === 'QUEUE_FULL') {
      return res.status(429).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }

  res.status(202).json({ jobId, status: 'pending' });
});

async function runIngested(jobId, videoPath, duration, options = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (Number(job.schemaVersion) === 2) {
    return pipelineService.runDecomposer(jobId, videoPath, options.pipelineOptions || {});
  }
  return legacyPipelineService.runLegacyIngested(jobId, videoPath, duration);
}

async function runUrl(jobId, url, options = {}) {
  try {
    updateJob(jobId, { status: 'downloading' });
    const download = options.downloadVideo || downloadVideo;
    const guardDuration = options.guardDuration || ingestion.guardDuration;
    const videoPath = await download(url, jobId, (pct) => {
      updateJob(jobId, { progress: Math.round(pct * 0.4) }); // 0-40%
    });
    const duration = await guardDuration(videoPath);
    return await runIngested(jobId, videoPath, duration, options);
  } catch (err) {
    updateJob(jobId, { status: 'failed', error: err.message });
    return getJob(jobId);
  }
}

router.post('/extract/upload', requireApiKey, rateLimit, (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      await removeTempUpload(req._uploadTempPath).catch(() => {});
      const error = multerErr.code === 'LIMIT_FILE_SIZE'
        ? `File vượt quá ${MAX_UPLOAD_MB}MB`
        : `Lỗi upload: ${multerErr.message}`;
      return res.status(multerErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error });
    }

    if (!req.file) {
      await removeTempUpload(req._uploadTempPath).catch(() => {});
      return res.status(400).json({ error: 'Không nhận được file (đúng tên field là "file"?)' });
    }

    const jobId = randomUUID();
    const job = createDecomposerJob(jobId, {
      sourceType: 'upload',
      originalFilename: req.file.originalname,
    });

    let queued;
    try {
      queued = pipelineQueue.enqueue(job.id, () => runUpload(job.id, req.file));
    } catch (err) {
      await removeTempUpload(req.file.path).catch(() => {});
      removeJob(job.id);
      if (err.code === 'QUEUE_FULL') {
        return res.status(429).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
    return res.status(202).json({ jobId: job.id, status: queued.queued ? 'pending' : 'uploading' });
  });
});

async function runUpload(jobId, file, options = {}) {
  try {
    updateJob(jobId, { status: 'uploading' });
    const acceptUpload = options.acceptUpload || ingestion.acceptUpload;
    const { videoPath, duration } = await acceptUpload(jobId, file);
    updateJob(jobId, { progress: 40 });
    return await runIngested(jobId, videoPath, duration, options);
  } catch (err) {
    await removeTempUpload(file?.path).catch(() => {});
    updateJob(jobId, { status: 'failed', error: err.message });
    return getJob(jobId);
  }
}

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  res.json(serializeJob(job));
});

// Expose pipeline stages for focused integration tests; HTTP behavior remains
// available through the router itself.
router.runIngested = runIngested;
router.runLegacyIngested = legacyPipelineService.runLegacyIngested;
router.runUrl = runUrl;
router.runUpload = runUpload;

module.exports = router;
