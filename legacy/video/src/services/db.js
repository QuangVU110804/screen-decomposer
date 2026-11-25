// SQLite persistence layer built on Node's built-in node:sqlite (no native
// addons to compile — available since Node 22.5, unflagged since 22.13 / 23.0).
// Used to persist the job store so history survives a server restart.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.join(process.env.LEGACY_DATA_ROOT || path.join(__dirname, '..', '..'), 'data');
const DB_PATH = path.join(DB_DIR, 'jobs.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
// WAL keeps reads/writes from blocking each other under the rapid per-update
// writes the pipeline does while a job runs.  busy_timeout tells SQLite to
// wait up to 5s before returning BUSY — needed when node --test runs multiple
// test files concurrently against the same database file.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
`);

function persistJob(job) {
  db.prepare(
    `INSERT INTO jobs (id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(job.id, JSON.stringify(job), job.createdAt, job.updatedAt);
}

function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function loadJob(id) {
  const row = db.prepare('SELECT data FROM jobs WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

function loadAllJobs() {
  const rows = db.prepare('SELECT data FROM jobs ORDER BY created_at ASC').all();
  return rows.map((row) => JSON.parse(row.data));
}

// Called once at boot: mark any jobs that were mid-flight before a restart as
// failed. Pipelines cannot be resumed (their task closures are gone), but the
// asset files and metadata already persisted survive intact.
function markInterruptedJobsFailed() {
  const INTERRUPTIBLE = new Set([
    'pending', 'downloading', 'uploading', 'sampling', 'filtering',
    'analyzing', 'finalizing', 'probing', 'detecting_scenes',
    'selecting_keyframes', 'understanding_scenes', 'associating_elements',
    'extracting_direct_assets', 'segmenting', 'recovering_backgrounds',
    'validating_assets', 'deduplicating', 'packaging',
  ]);
  const failed = [];
  for (const job of loadAllJobs()) {
    if (INTERRUPTIBLE.has(job.status)) {
      const interruptedStage = (
        job.stage &&
        job.stage !== 'pending' &&
        job.stage !== 'failed'
      ) ? job.stage : job.status;
      job.status = 'failed';
      job.stage = 'failed';
      job.queuePosition = null;
      job.error = 'Server đã khởi động lại đang giữa chừng — job này không thể tiếp tục.';
      job.failures = [
        ...(Array.isArray(job.failures) ? job.failures : []),
        {
          stage: interruptedStage,
          code: 'SERVER_RESTART_INTERRUPTED',
          message: job.error,
        },
      ];
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      persistJob(job);
      failed.push(job.id);
    }
  }
  return failed;
}

module.exports = {
  DB_PATH,
  persistJob,
  deleteJob,
  loadJob,
  loadAllJobs,
  markInterruptedJobsFailed,
};
