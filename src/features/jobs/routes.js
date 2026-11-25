'use strict';
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { jobDir, publicJob } = require('../elements/pipeline');
const { scopedPath, linkImmutable } = require('../../shared/files');
const { streamExport } = require('../elements/export');
function createJobRoutes({ config, store, queue, pipeline, editor }) {
  const router = express.Router();
  const layerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxBytes, files: 1, fields: 3, parts: 5 } }).single('file');
  const layerAction = action => async (req, res, next) => { try { res.json(await action(req)); } catch (error) { next(error); } };
  router.get('/', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    res.json({ jobs: store.list(Math.floor(limit), offset).map(job => ({ id: job.id, name: job.name, status: job.status, count: job.elements?.length || 0, createdAt: job.createdAt, previewUrl: `/api/jobs/${job.id}/media/preview` })) });
  });
  router.use('/:id', (req, res, next) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Không tìm thấy job.' });
    req.job = store.get(req.params.id);
    if (!req.job) return res.status(404).json({ error: 'Không tìm thấy job.' });
    next();
  });
  router.get('/:id/elements/:elementId/edit', layerAction(req => editor.getEdit(req.params.id, req.params.elementId)));
  router.post('/:id/elements/:elementId/mask', layerAction(req => editor.mask(req.params.id, req.params.elementId, req.body)));
  router.post('/:id/elements/:elementId/reset-mask', layerAction(req => editor.reset(req.params.id, req.params.elementId, req.body)));
  router.patch('/:id/layers', layerAction(req => editor.placement(req.params.id, req.body)));
  router.post('/:id/layers', layerUpload, layerAction(req => editor.importLayer(req.params.id, req.file, req.body)));
  router.get('/:id', (req, res) => res.json(publicJob(req.job)));
  router.post('/:id/cancel', (req, res) => res.json(publicJob(queue.cancel(req.job.id))));
  router.post('/:id/retry', async (req, res, next) => {
    try {
      if (!['done', 'partial', 'failed', 'canceled'].includes(req.job.status)) throw Object.assign(new Error('Lượt quét vẫn đang chạy.'), { status: 409 });
      const preset = req.body.preset || req.job.preset;
      if (!config.presets[preset]) throw Object.assign(new Error('Preset không hợp lệ.'), { status: 400 });
      if (!queue.hasCapacity()) throw Object.assign(new Error('Hàng đợi đầy.'), { status: 429 });
      editor.trackRead(req.job.id,res);
      const id = crypto.randomUUID(), dir = jobDir(config, id);
      await fs.mkdir(dir, { recursive: true });
      try {
        for (const name of ['source.png', 'preview.webp']) await linkImmutable(path.join(jobDir(config, req.job.id), name), path.join(dir, name));
        const job = store.put({ id, name: req.job.name, source: req.job.source, preset, engineFingerprint: req.app.locals.engineFingerprint(), status: 'queued', stage: 'queued', elements: [], progress: 0 });
        queue.submit(id, signal => pipeline(id, signal));
        res.status(202).json(publicJob(job));
      } catch (error) { await fs.rm(dir, { recursive: true, force: true }); store.remove(id); throw error; }
    } catch (error) { next(error); }
  });
  router.patch('/:id/selection', async (req, res, next) => {
    try { await editor.withJob(req.job.id, async job => { req.job = job;
      const { ids, selected } = req.body;
      if (!['done','partial'].includes(req.job.status)) throw Object.assign(new Error('Job chưa có kết quả.'),{status:409});
      if (!Array.isArray(ids) || ids.length>80 || typeof selected!=='boolean' || ids.some(id=>!req.job.elements.some(e=>e.id===id))) throw Object.assign(new Error('Danh sách element không hợp lệ.'),{status:400});
      const chosen=new Set(ids);for(const e of req.job.elements)if(chosen.has(e.id))e.selected=selected;
      store.put(req.job);res.json(publicJob(req.job)); });
    }catch(error){next(error);}
  });
  router.patch('/:id/elements/:elementId', async (req, res, next) => {
    try { await editor.withJob(req.job.id, async job => { req.job = job;
      if (!['done', 'partial'].includes(req.job.status)) throw Object.assign(new Error('Job chưa có kết quả để sửa.'), { status: 409 });
      const element = req.job.elements.find(e => e.id === req.params.elementId);
      if (!element) return res.status(404).json({ error: 'Không tìm thấy element.' });
      const { label, type, selected } = req.body;
      if ((label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) || (type !== undefined && !['region', 'text-region', 'character', 'graphic', 'background'].includes(type)) || (selected !== undefined && typeof selected !== 'boolean')) throw Object.assign(new Error('Nhãn hoặc lựa chọn không hợp lệ.'), { status: 400 });
      if (label !== undefined) element.label = label.trim();
      if (type !== undefined) element.type = type;
      if (selected !== undefined) element.selected = selected;
      store.put(req.job); res.json(publicJob(req.job)); });
    } catch (error) { next(error); }
  });
  router.get('/:id/media/:fileId', (req, res, next) => {
    const base = jobDir(config, req.job.id), key = req.params.fileId;
    let file;
    if (key === 'source') file = path.join(base, 'source.png');
    else if (key === 'preview') file = path.join(base, 'preview.webp');
    else {
      const match = /^(region_\d{3}|text_\d{3})-(image|thumb|mask|edit-source|edit-mask)$/.exec(key);
      const e = match && req.job.elements?.find(item => item.id === match[1]);
      if (e) { const name = e[({ image: 'file', thumb: 'thumbnail', mask: 'mask', 'edit-source': 'editSourceFile', 'edit-mask': 'mask' })[match[2]]]; if (name) file = scopedPath(path.join(base, 'elements'), name); }
    }
    if (!file) return res.status(404).json({ error: 'Không tìm thấy file.' });
    editor.trackRead(req.job.id,res);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, error => { if (error && !res.headersSent) next(Object.assign(new Error('File đã hết hạn hoặc không tồn tại.'), { status: 404 })); });
  });
  router.post('/:id/export', (req, res, next) => {
    try {
      if (!['done', 'partial'].includes(req.job.status)) throw Object.assign(new Error('Chưa có kết quả để tải.'), { status: 409 });
      editor.trackRead(req.job.id,res);
      streamExport(req.job, req.body.ids ?? req.job.elements.filter(e => e.selected !== false).map(e => e.id), path.join(jobDir(config, req.job.id), 'elements'), res);
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { createJobRoutes };
