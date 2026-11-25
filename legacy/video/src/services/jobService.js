// Job store backed by SQLite via db.js.  API surface is identical to the
// previous in-memory Map version so existing callers do not change.
const db = require('./db');

function createJob(id, data = {}) {
  const schemaVersion = Number(data.schemaVersion || 1);
  const job = {
    id,
    schemaVersion,
    resultType: schemaVersion === 2 ? 'decomposer' : 'legacy-frame',
    legacyFrameResult: schemaVersion !== 2,
    status: 'pending',
    stage: 'pending',
    sourceType: null,
    sourceUrl: null,
    originalFilename: null,
    videoPath: null,
    duration: null,
    progress: 0,
    candidates: [],
    video: null,
    scenes: [],
    tracks: [],
    assets: [],
    failures: [],
    metrics: {},
    feedback: [],
    queuePosition: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data,
  };
  db.persistJob(job);
  return job;
}

function createDecomposerJob(id, data = {}) {
  return createJob(id, {
    ...data,
    schemaVersion: 2,
    resultType: 'decomposer',
    legacyFrameResult: false,
  });
}

function updateJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  const previousUpdatedAt = job.updatedAt;
  let updatedAt = new Date().toISOString();
  if (previousUpdatedAt && updatedAt <= previousUpdatedAt) {
    updatedAt = new Date(new Date(previousUpdatedAt).getTime() + 1).toISOString();
  }
  Object.assign(job, patch, { updatedAt });
  db.persistJob(job);
  return job;
}

function getJob(id) {
  return db.loadJob(id);
}

function getJobOrThrow(id) {
  const job = getJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  return job;
}

function removeJob(id) {
  db.deleteJob(id);
}

function listJobs() {
  return db.loadAllJobs().map((j) => ({
    id: j.id,
    schemaVersion: Number(j.schemaVersion || 1),
    resultType: Number(j.schemaVersion || 1) === 2 ? 'decomposer' : 'legacy-frame',
    legacyFrameResult: Number(j.schemaVersion || 1) !== 2,
    status: j.status,
    stage: j.stage || j.status,
    progress: j.progress,
    sourceType: j.sourceType,
    assetCount: Number(j.schemaVersion || 1) === 2
      ? (
        j.assetCount ??
        (Array.isArray(j.assets)
          ? j.assets.filter((asset) => asset.qualityState !== 'failed').length
          : 0)
      )
      : (Array.isArray(j.assets) ? j.assets.length : 0),
    sceneCount: Array.isArray(j.scenes) ? j.scenes.length : 0,
    queuePosition: j.queuePosition ?? null,
    createdAt: j.createdAt,
  }));
}

module.exports = { createJob, createDecomposerJob, updateJob, getJob, getJobOrThrow, removeJob, listJobs };
