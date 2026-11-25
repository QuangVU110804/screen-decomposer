'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { directoryBytes, scopedPath } = require('../../shared/files');
const { discardWorkerFiles, trimOutputToBudget } = require('./budget');
const { linkArtifacts, writeCache } = require('./cache');
function jobDir(config, id) { return path.join(config.dataDir, 'jobs', id); }
function publicJob(job) {
  const prefix = `/api/jobs/${encodeURIComponent(job.id)}/media/`;
  const { sourcePath, cacheKey, ...safe } = job;
  return { ...safe, sourceUrl: prefix + 'source', previewUrl: prefix + 'preview', elements: (job.elements || []).map(({ file, mask, thumbnail, sourceFile, editSourceFile, initialFile, initialMask, initialThumbnail, initialSourcePixelsOnly, ...e }, index) => { const query = '?revision=' + (e.editRevision || 0); return { ...e, editRevision: e.editRevision || 0, placement: e.placement || { x: e.bbox[0], y: e.bbox[1] }, layerVisible: e.layerVisible !== false, layerOrder: e.layerOrder ?? index, url: prefix + e.id + '-image' + query, thumbnailUrl: prefix + e.id + '-thumb' + query, maskUrl: mask ? prefix + e.id + '-mask' + query : null }; }) };
}
async function validateElements(elements, output, maxAssets) {
  if (!Array.isArray(elements) || elements.length > maxAssets) throw new Error('Số element từ engine vượt giới hạn.');
  const ids = new Set();
  for (const element of elements) {
    if (!/^(region|text)_\d{3}$/.test(element.id) || ids.has(element.id)) throw new Error('Engine trả element ID không hợp lệ.');
    ids.add(element.id);
    if (!Array.isArray(element.bbox) || element.bbox.length !== 4 || element.bbox.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Engine trả tọa độ không hợp lệ.');
    for (const file of [element.file, element.thumbnail, element.mask, element.sourceFile].filter(Boolean)) {
      if (!/^(region|text)_\d{3}(\.(mask|source))?\.(png|webp)$/.test(file)) throw new Error('Engine trả tên file không hợp lệ.');
      const info = await fs.stat(scopedPath(output, file));
      if (!info.isFile() || !info.size) throw new Error('Engine không tạo được file element.');
    }
  }
  return elements;
}
function associateRegions(elements) {
  return elements.map(e => {
    const [x, y, w, h] = e.bbox;
    const parent = elements.filter(p => {
      if (p.id === e.id) return false;
      const [px, py, pw, ph] = p.bbox;
      return w * h < pw * ph * 0.85 && x >= px && y >= py && x+w <= px+pw && y+h <= py+ph;
    }).sort((a, b) => a.bbox[2] * a.bbox[3] - b.bbox[2] * b.bbox[3])[0];
    return { ...e, parentId: parent?.id || null };
  });
}
function createPipeline({ config, store, worker }) {
  return async function pipeline(id, signal) {
    let job = store.get(id);
    const dir = jobDir(config, id), output = path.join(dir, 'elements');
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ source: job.source.hash, preset: job.preset, engine: job.engineFingerprint, pipeline: 4 })).digest('hex');
    const cache = path.join(config.dataDir, 'cache', cacheKey);
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let budgetError, checking = false, timer;
    const save = patch => { const current = store.get(id); job = store.put({ ...current, ...patch }); };
    try {
      if (signal.aborted) throw new Error('Đã hủy tác vụ.');
      await fs.rm(output, { recursive: true, force: true });
      await fs.mkdir(output, { recursive: true });
      if (signal.aborted) throw new Error('Đã hủy tác vụ.');
      save({ status: 'running', stage: 'text', progress: 15, error: null });
      let result, cacheHit = false;
      try {
        result = JSON.parse(await fs.readFile(path.join(cache, 'result.json'), 'utf8'));
        await validateElements(result.elements, cache, config.maxAssets);
        await linkArtifacts(result.elements, cache, output);
        cacheHit = true;
        const now = new Date();
        await fs.utimes(cache, now, now).catch(() => {});
      } catch {
        // A worker may reuse the filenames, so discard any partially restored links before running it.
        if (result) await discardWorkerFiles(output, []);
        result = null;
      }
      if (!result) {
        if (signal.aborted) throw new Error('Đã hủy tác vụ.');
        timer = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            if (await directoryBytes(dir) > config.maxArtifactBytes) { budgetError = new Error('Job vượt giới hạn dung lượng 512 MB.'); controller.abort(); }
          } catch { /* directories can disappear only during shutdown */ }
          finally { checking = false; }
        }, 1500);
        try {
          result = await worker(config, { source: path.join(dir, 'source.png'), output, modelDir: config.modelDir, preset: job.preset, maxAssets: config.maxAssets }, {
            signal: controller.signal,
            onEvent(event) {
              if (signal.aborted) return;
              if (event.type === 'stage') save({ stage: event.stage, progress: ({text:20,masks:35,tiles:75,refining:90})[event.stage] || 20 });
              else if (event.type === 'progress' && event.total > 0) {
                // Balanced scans tiles after the grid; keep progress monotonic across both passes.
                const [from, to] = job.stage === 'tiles' ? [75, 90] : [35, job.preset === 'balanced' ? 75 : 90];
                save({ progress: Math.min(90, from + Math.round((to - from) * event.completed / event.total)), foundCount: event.count });
              }
            },
          });
        } catch (error) {
          if (signal.aborted) throw error;
          // A timed-out segmentation stage may still leave valid OCR crops.
          try {
            result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
            if (!result.elements?.length) throw error;
            result.warnings = [...(result.warnings || []), error.message];
          } catch { throw error; }
        } finally { clearInterval(timer); }
      }
      if (signal.aborted) throw new Error('Đã hủy tác vụ.');
      await validateElements(result.elements, output, config.maxAssets);
      if (budgetError || await directoryBytes(dir) > config.maxArtifactBytes) {
        result = await trimOutputToBudget(config, dir, output, result);
      } else await discardWorkerFiles(output, result.elements);
      save({ stage: 'export', progress: 94 });
      result.elements = associateRegions(result.elements);
      const warnings = result.warnings || [];
      const goodEngines = Object.values(result.engines || {}).some(e => e.ok);
      if (!goodEngines && !result.elements.length) throw new Error('Không có engine local nào xử lý thành công.');
      if (!goodEngines) warnings.push('Engine chưa hoàn tất; giữ lại các element hợp lệ từ checkpoint.');
      const completion = { status: warnings.length ? 'partial' : 'done', stage: warnings.length ? 'partial' : 'done', progress: 100,
        elements: result.elements, warnings, engines: result.engines, postprocess:result.postprocess || {}, timings: { ...result.timings, jobMs: Date.now()-started },
        completedAt: new Date().toISOString(), cacheHit };
      if (!cacheHit && !warnings.length) {
        try { await writeCache(config, cache, id, result, output); }
        catch { completion.cacheWarning = 'Không lưu được cache; các element hiện tại vẫn tải được.'; }
      }
      if (signal.aborted) throw new Error('Đã hủy tác vụ.');
      save(completion);
    } catch (error) {
      await discardWorkerFiles(output, []).catch(() => {});
      if (signal.aborted) save({ status: 'canceled', stage: 'canceled', error: null });
      else save({ status: 'failed', stage: 'failed', error: error.message });
    } finally { clearInterval(timer); signal.removeEventListener('abort', abort); }
  };
}
module.exports = { createPipeline, jobDir, publicJob, validateElements };
