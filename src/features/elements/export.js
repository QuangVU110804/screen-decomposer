'use strict';
const path = require('node:path');
const archiver = require('archiver');
const { scopedPath } = require('../../shared/files');
const { publicJob } = require('./pipeline');
function streamExport(job, ids, outputDir, res) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length) throw Object.assign(new Error('Chọn ít nhất một element hợp lệ.'), { status: 400 });
  const elements = ids.map(id => (job.elements || []).find(e => e.id === id));
  if (elements.some(e => !e)) throw Object.assign(new Error('Element không thuộc job này.'), { status: 400 });
  const archive = archiver('zip', { zlib: { level: 1 } });
  res.attachment(`elements-${job.id.slice(0, 8)}.zip`);
  archive.on('error', error => res.destroy(error));
  res.on('close', () => { if (!res.writableFinished) archive.abort(); });
  archive.pipe(res);
  const manifest = publicJob({ ...job, elements });
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  for (const e of elements) {
    archive.file(scopedPath(outputDir, e.file), { name: `assets/${e.id}.png` });
    if (e.mask) archive.file(scopedPath(outputDir, e.mask), { name: `masks/${e.id}.png` });
  }
  archive.finalize().catch(error => res.destroy(error));
}
module.exports = { streamExport };
