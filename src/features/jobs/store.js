'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const terminal = new Set(['done', 'partial', 'failed', 'canceled']);
function createStore(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'jobs.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL)');
  const get = (id) => { const r = db.prepare('SELECT data FROM image_jobs WHERE id=?').get(id); return r ? JSON.parse(r.data) : null; };
  const put = (job) => {
    job.updatedAt = new Date().toISOString(); job.createdAt ||= job.updatedAt;
    db.prepare('INSERT INTO image_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(job.id, JSON.stringify(job), job.updatedAt);
    return job;
  };
  for (const row of db.prepare('SELECT data FROM image_jobs').all()) {
    const job = JSON.parse(row.data);
    if (!terminal.has(job.status)) put({ ...job, status: 'failed', stage: 'failed', error: 'Ứng dụng khởi động lại khi đang xử lý. Bạn có thể quét lại.', elements: job.elements || [] });
  }
  return { get, put,
    list: (limit = 20, offset = 0) => db.prepare('SELECT data FROM image_jobs ORDER BY updated DESC LIMIT ? OFFSET ?').all(limit, offset).map(r => JSON.parse(r.data)),
    remove: (id) => db.prepare('DELETE FROM image_jobs WHERE id=?').run(id), close: () => db.close(),
  };
}
module.exports = { createStore, terminal };
