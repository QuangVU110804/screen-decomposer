'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createConfig } = require('./config/index');
const { createStore, terminal } = require('./features/jobs/store');
const { createQueue } = require('./features/jobs/queue');
const { normalizeImage } = require('./features/images/normalize');
const { createPipeline, jobDir, publicJob } = require('./features/elements/pipeline');
const { pruneCache } = require('./features/elements/cache');
const { createLayerEditor } = require('./features/elements/editing');
const { createJobRoutes } = require('./features/jobs/routes');
const { runWorker, engineStatus } = require('./integrations/python/worker');
const { createWatermarkRoutes } = require('./features/watermark/routes');
function createApp({ config = createConfig(), worker = runWorker, watermarkWorker = runWorker, status = () => engineStatus(config) } = {}) {
  const app = express(), store = createStore(config), queue = createQueue(store, config.maxWaiting);
  const pipeline = createPipeline({ config, store, worker });
  const editor = createLayerEditor({ config, store });
  let readiness, checkedAt = 0, statusPromise, preprocessing = false;
  async function getStatus() {
    if (readiness && Date.now() - checkedAt < 15000) return readiness;
    if (!statusPromise) statusPromise = Promise.resolve().then(status).then(value => { readiness = value; checkedAt = Date.now(); return value; }).finally(() => { statusPromise = null; });
    return statusPromise;
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    if (req.headers.host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host)) return res.status(403).json({ error: 'Chỉ cho phép truy cập local.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Không chấp nhận yêu cầu từ website khác.' });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ ok: true, app: 'image-elements' }));
  app.get('/api/config', (req, res) => res.json({ maxUploadMb: 20, maxPixels: config.maxPixels, presets: config.presets, retentionHours: 24, requiresApiKey: false }));
  app.get('/api/engine/status', async (req, res, next) => { try { res.json(await getStatus()); } catch (error) { next(error); } });
  app.locals.engineFingerprint = () => readiness?.fingerprint || 'unknown';
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxBytes, files: 1, fields: 1, parts: 3 } }).single('file');
  app.post('/api/images', async (req, res, next) => {
    if (!queue.hasCapacity() || preprocessing) return res.status(429).json({ error: 'Ứng dụng đang bận. Hãy chờ rồi thử lại.' });
    preprocessing = true;
    let id, dir;
    let disconnected = false;
    const disconnect = () => { if (!res.writableEnded) disconnected = true; };
    res.once('close', disconnect);
    try {
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      if (!req.file) throw Object.assign(new Error('Hãy chọn một ảnh.'), { status: 400 });
      const preset = req.body.preset || 'fast';
      if (!config.presets[preset]) throw Object.assign(new Error('Preset không hợp lệ.'), { status: 400 });
      id = crypto.randomUUID(); dir = jobDir(config, id);
      const source = await normalizeImage(req.file.buffer, dir, config);
      const ready = await getStatus();
      if (disconnected || req.aborted) throw Object.assign(new Error('Upload đã ngắt kết nối.'), { status: 400 });
      if (!ready.ready && !ready.segmentation && !ready.text) throw Object.assign(new Error(ready.message || 'Engine chưa sẵn sàng. Chạy npm run setup:local.'), { status: 503 });
      const job = store.put({ id, name: path.basename(req.file.originalname).slice(0, 160), source: { width: source.width, height: source.height, hash: source.hash }, preset, engineFingerprint: ready.fingerprint || 'unknown', status: 'queued', stage: 'queued', progress: 0, elements: [], warnings: [] });
      queue.submit(id, signal => pipeline(id, signal));
      res.status(202).json(publicJob(job));
    } catch (error) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (id) store.remove(id);
      next(error);
    } finally { preprocessing = false; res.removeListener('close', disconnect); }
  });
  app.use('/api/jobs', createJobRoutes({ config, store, queue, pipeline, editor }));
  const watermark = createWatermarkRoutes({config, worker:watermarkWorker});
  app.use('/api/watermark', watermark);
  app.locals.watermark = watermark;
  app.use(express.static(config.webDir));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const statusCode = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : error.status || 500;
    res.status(statusCode).json({ error: error instanceof multer.MulterError ? 'Upload không hợp lệ hoặc vượt giới hạn 20 MB.' : error.message || 'Có lỗi xử lý.' });
  });
  let cleanupTask;
  async function sweep() {
    const jobs = path.join(config.dataDir, 'jobs');
    for (const entry of await fs.readdir(jobs, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const dir = jobDir(config, entry.name);
      await editor.withJob(entry.name, async job => {
        if (job) {
          if (!terminal.has(job.status) || editor.hasReaders(job.id) || Date.now() - Date.parse(job.updatedAt) <= config.retentionMs) return;
          store.remove(job.id);
        } else if (Date.now() - (await fs.stat(dir)).mtimeMs <= config.retentionMs) return;
        await fs.rm(dir, { recursive: true, force: true });
      }).catch(error => { if (error.code !== 'ENOENT') console.error(error); });
    }
    await pruneCache(config);
  }
  const startSweep = () => { cleanupTask ??= sweep().catch(console.error).finally(() => { cleanupTask = null; }); };
  startSweep();
  const cleanup = setInterval(startSweep, 60 * 60 * 1000); cleanup.unref();
  app.locals.close = async () => { clearInterval(cleanup); await watermark.close(); await queue.close(); await cleanupTask; store.close(); };
  app.locals.store = store;
  return app;
}
module.exports = { createApp };
