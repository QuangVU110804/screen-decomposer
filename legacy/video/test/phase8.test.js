const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const config = require('../src/config');
const db = require('../src/services/db');
const jobService = require('../src/services/jobService');
const { rateLimit, requireApiKey } = require('../src/middleware/security');

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('job store persists to SQLite so history survives a restart', () => {
  const id = `phase8-persist-${Date.now()}`;
  const decomposerId = `phase8-history-v2-${Date.now()}`;
  try {
    jobService.createJob(id, { sourceType: 'upload', originalFilename: 'x.mp4' });
    jobService.updateJob(id, { progress: 42, status: 'sampling' });
    jobService.createDecomposerJob(decomposerId, {
      status: 'partial',
      assets: [
        { assetId: 'asset_001', qualityState: 'usable' },
        { assetId: 'asset_002', qualityState: 'failed' },
      ],
    });

    // Read it back straight from the on-disk DB (a fresh process / reload would
    // see the exact same row) to prove it isn't only in-memory.
    const raw = db.loadJob(id);
    assert.ok(raw, 'job should be found in the SQLite store');
    assert.equal(raw.status, 'sampling');
    assert.equal(raw.progress, 42);
    assert.equal(raw.sourceType, 'upload');
    const v2Summary = jobService.listJobs().find((job) => job.id === decomposerId);
    assert.equal(v2Summary.assetCount, 1, 'history counts reusable v2 assets, not diagnostics');
  } finally {
    jobService.removeJob(id);
    jobService.removeJob(decomposerId);
    assert.equal(db.loadJob(id), null);
  }
});

test('markInterruptedJobsFailed flags mid-flight jobs as failed and leaves settled jobs alone', () => {
  const running = `phase8-running-${Date.now()}`;
  const done = `phase8-done-${Date.now()}`;
  try {
    jobService.createJob(running, { status: 'analyzing', progress: 60 });
    jobService.createJob(done, { status: 'done', progress: 100 });
    jobService.createJob(done + 'b', { status: 'failed', error: 'old error' });

    const recovered = db.markInterruptedJobsFailed();

    assert.ok(recovered.includes(running), `expected ${running} to be recovered`);

    const runningJob = db.loadJob(running);
    assert.equal(runningJob.status, 'failed');
    assert.equal(runningJob.stage, 'failed');
    assert.equal(runningJob.queuePosition, null);
    assert.match(runningJob.error, /khởi động lại/);
    assert.ok(runningJob.completedAt);
    assert.deepEqual(
      runningJob.failures.at(-1),
      {
        stage: 'analyzing',
        code: 'SERVER_RESTART_INTERRUPTED',
        message: runningJob.error,
      }
    );

    assert.equal(db.loadJob(done).status, 'done');
    assert.equal(db.loadJob(done + 'b').status, 'failed');
    assert.equal(db.loadJob(done + 'b').error, 'old error');
  } finally {
    jobService.removeJob(running);
    jobService.removeJob(done);
    jobService.removeJob(done + 'b');
  }
});

test('rate limit rejects requests that exceed the per-window budget', async () => {
  const originalMax = config.RATE_LIMIT_MAX;
  const originalWindow = config.RATE_LIMIT_WINDOW_MS;
  config.RATE_LIMIT_MAX = 3;
  config.RATE_LIMIT_WINDOW_MS = 60_000;
  const app = express();
  app.post('/test', rateLimit, (_req, res) => res.json({ ok: true }));
  const { server, base } = await listen(app);
  try {
    const statuses = [];
    for (let index = 0; index < 5; index++) {
      const response = await fetch(`${base}/test`, { method: 'POST' });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    const limited = await fetch(`${base}/test`, { method: 'POST' });
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.match(body.error, /Quá nhiều/);
  } finally {
    server.close();
    config.RATE_LIMIT_MAX = originalMax;
    config.RATE_LIMIT_WINDOW_MS = originalWindow;
  }
});

test('optional API-key auth requires X-API-Key only when enabled', async () => {
  const originalKey = config.API_KEY;

  // Disabled -> any request passes through.
  config.API_KEY = '';
  const disabledApp = express();
  disabledApp.post('/t', requireApiKey, (_req, res) => res.json({ ok: true }));
  {
    const { server, base } = await listen(disabledApp);
    try {
      const response = await fetch(`${base}/t`, { method: 'POST' });
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  }

  // Enabled -> missing/wrong key rejected, correct key accepted.
  config.API_KEY = 'secret-demo-key';
  const enabledApp = express();
  enabledApp.post('/t', requireApiKey, (_req, res) => res.json({ ok: true }));
  {
    const { server, base } = await listen(enabledApp);
    try {
      const noKey = await fetch(`${base}/t`, { method: 'POST' });
      assert.equal(noKey.status, 401);
      const wrongKey = await fetch(`${base}/t`, {
        method: 'POST',
        headers: { 'x-api-key': 'wrong' },
      });
      assert.equal(wrongKey.status, 401);
      const queryKey = await fetch(`${base}/t?apiKey=secret-demo-key`, {
        method: 'POST',
      });
      assert.equal(queryKey.status, 401, 'credentials in URLs must not be accepted');
      const rightKey = await fetch(`${base}/t`, {
        method: 'POST',
        headers: { 'x-api-key': 'secret-demo-key' },
      });
      assert.equal(rightKey.status, 200);
    } finally {
      server.close();
    }
  }

  config.API_KEY = originalKey;
});
