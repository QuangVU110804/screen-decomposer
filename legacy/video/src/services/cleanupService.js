const fs = require('fs');
const path = require('path');

const config = require('../config');
const pipelineQueue = require('./pipelineQueue');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let scheduler = null;

function isStale(entryPath, retentionHours, now = Date.now()) {
  const stat = fs.statSync(entryPath);
  const ageHours = (now - stat.mtimeMs) / 3_600_000;
  return ageHours > retentionHours;
}

function protectedJobIds() {
  const state = pipelineQueue.getState();
  return new Set([state.activeJobId, ...state.waiting].filter(Boolean));
}

function isProtectedEntry(base, entry, jobIds) {
  if (base === config.ASSET_DIR) {
    return [...jobIds].some((jobId) => (
      entry === jobId ||
      entry.startsWith(`.staging-${jobId}-`) ||
      entry.startsWith(`.staging-v2-${jobId}-`) ||
      entry.startsWith(`${jobId}.backup-`)
    ));
  }
  if (base === config.CANDIDATE_DIR || base === config.JOB_DIR) {
    return jobIds.has(entry);
  }
  if (base === config.VIDEO_DIR) {
    return [...jobIds].some((jobId) => entry.startsWith(`${jobId}.`));
  }
  // Upload staging names are random .part files and their mtime is the best
  // available signal; queued uploads normally wait only minutes, not hours.
  return false;
}

function sweepOnce({
  retentionHours = config.ASSET_RETENTION_HOURS,
  now = Date.now(),
  bases = [config.VIDEO_DIR, config.CANDIDATE_DIR, config.ASSET_DIR, config.JOB_DIR, config.UPLOAD_TMP_DIR],
} = {}) {
  const jobIds = protectedJobIds();
  let removed = 0;
  let failed = 0;

  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch (err) {
      failed++;
      console.warn(`[cleanup] failed to list ${base}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      if (isProtectedEntry(base, entry, jobIds)) continue;
      const full = path.join(base, entry);
      try {
        // Directory mtime changes as a job writes files. With retention set
        // to hours, an active job is naturally safe; protected IDs add a
        // second guard for unusually long-running work.
        if (!isStale(full, retentionHours, now)) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
        console.log(`[cleanup] removed ${full}`);
      } catch (err) {
        failed++;
        // One locked file/directory must not abort the rest of the sweep.
        console.warn(`[cleanup] failed on ${full}: ${err.message}`);
      }
    }
  }

  console.log(`[cleanup] sweep complete: removed=${removed} failed=${failed}`);
  return { removed, failed };
}

function startCleanupScheduler({ intervalMs = SWEEP_INTERVAL_MS } = {}) {
  if (scheduler) return scheduler;
  sweepOnce();
  scheduler = setInterval(() => sweepOnce(), intervalMs);
  // The cleanup timer should not keep short-lived CLI/test processes alive.
  if (typeof scheduler.unref === 'function') scheduler.unref();
  return scheduler;
}

function stopCleanupScheduler() {
  if (!scheduler) return;
  clearInterval(scheduler);
  scheduler = null;
}

module.exports = {
  SWEEP_INTERVAL_MS,
  isStale,
  isProtectedEntry,
  sweepOnce,
  startCleanupScheduler,
  stopCleanupScheduler,
};
