const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

require('dotenv').config();
const config = require('../src/config');
const jobService = require('../src/services/jobService');
const pipelineQueue = require('../src/services/pipelineQueue');
const cleanupService = require('../src/services/cleanupService');
const vision = require('../src/services/visionService');
const extractRoutes = require('../src/routes/extractRoutes');
const ingestion = require('../src/services/ingestionService');
const { upload, removeTempUpload } = require('../src/middleware/upload');

function waitForIdle(timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = pipelineQueue.getState();
      if (!state.running && state.waiting.length === 0) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('queue did not drain'));
      return setTimeout(check, 5);
    };
    check();
  });
}

function makeJobId(prefix, index) {
  return `${prefix}-${Date.now()}-${index}`;
}

test('single-flight queue serializes work, tracks five waiting jobs, and continues after failure', async () => {
  pipelineQueue.resetForTests();
  const ids = Array.from({ length: 7 }, (_value, index) => makeJobId('phase7-queue', index));
  ids.forEach((id) => jobService.createJob(id));
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  pipelineQueue.enqueue(ids[0], async () => {
    order.push(0);
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipelineQueue.getState().activeJobId, ids[0]);

  for (let index = 1; index <= 5; index++) {
    pipelineQueue.enqueue(ids[index], async () => {
      order.push(index);
      if (index === 3) throw new Error('deliberate queue failure');
    });
    assert.equal(jobService.getJob(ids[index]).status, 'pending');
    assert.equal(jobService.getJob(ids[index]).queuePosition, index);
  }
  assert.throws(
    () => pipelineQueue.enqueue(ids[6], async () => {}),
    (error) => error.code === 'QUEUE_FULL' && error.statusCode === 429
  );
  assert.equal(pipelineQueue.getState().waiting.length, pipelineQueue.MAX_QUEUE_WAITING);

  release();
  await waitForIdle();
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  assert.equal(jobService.getJob(ids[3]).status, 'failed');
  assert.match(jobService.getJob(ids[3]).error, /deliberate queue failure/);
  assert.equal(pipelineQueue.getState().running, false);
  ids.forEach((id) => jobService.removeJob(id));
});

test('cleanup sweep removes stale entries, keeps fresh entries, and survives one locked deletion', async () => {
  const root = await fs.promises.mkdtemp(path.join(config.TEMP_DIR, 'phase7-cleanup-'));
  const bases = ['videos', 'candidates', 'assets', 'uploads'].map((name) => path.join(root, name));
  await Promise.all(bases.map((base) => fs.promises.mkdir(base, { recursive: true })));
  const oldDate = new Date(Date.now() - 3 * 3_600_000);
  const freshFile = path.join(bases[3], 'fresh.part');
  const staleFile = path.join(bases[0], 'stale.mp4');
  const lockedFile = path.join(bases[3], 'locked.part');
  await fs.promises.writeFile(freshFile, 'fresh');
  await fs.promises.writeFile(staleFile, 'stale');
  await fs.promises.writeFile(lockedFile, 'locked');
  fs.utimesSync(staleFile, oldDate, oldDate);
  fs.utimesSync(lockedFile, oldDate, oldDate);
  assert.equal(cleanupService.isStale(staleFile, 1), true);
  assert.equal(cleanupService.isStale(freshFile, 1), false);
  const protectedIds = new Set(['active-job']);
  assert.equal(cleanupService.isProtectedEntry(config.ASSET_DIR, 'active-job', protectedIds), true);
  assert.equal(
    cleanupService.isProtectedEntry(config.ASSET_DIR, '.staging-v2-active-job-transaction', protectedIds),
    true
  );
  assert.equal(
    cleanupService.isProtectedEntry(config.ASSET_DIR, 'active-job.backup-transaction', protectedIds),
    true
  );
  assert.equal(
    cleanupService.isProtectedEntry(config.ASSET_DIR, 'unrelated-job.backup-transaction', protectedIds),
    false
  );

  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === lockedFile) throw new Error('file is locked');
    return originalRmSync(target, options);
  };
  let result;
  try {
    result = cleanupService.sweepOnce({ bases, retentionHours: 1 });
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(fs.existsSync(staleFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  assert.equal(fs.existsSync(lockedFile), true);
  assert.equal(result.removed, 1);
  assert.equal(result.failed, 1);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('Vision truncates candidates defensively and logs cost counters', async (t) => {
  const imagePath = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'bars.png');
  if (!fs.existsSync(imagePath)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const previousMax = config.MAX_CANDIDATES;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings = [];
  const logs = [];
  config.MAX_CANDIDATES = 5;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const calls = [];
    const client = { messages: { create: async (params) => {
      calls.push(params);
      const count = params.messages[0].content.filter((block) => block.type === 'image').length;
      return {
        content: [{
          type: 'tool_use',
          name: 'report_assets',
          input: { assets: Array.from({ length: count }, (_value, ref) => ({
            ref, isAsset: true, label: 'Slide', description: 'A slide.', confidence: 0.8,
          })) },
        }],
      };
    } } };
    const candidates = Array.from({ length: 20 }, (_value, index) => ({ path: imagePath, timestamp: index }));
    const results = await vision.classifyCandidates(candidates, null, {
      client,
      batchSize: 5,
      retries: 0,
      jobId: 'phase7-cost-test',
    });
    assert.equal(results.length, 5);
    assert.equal(calls.length, 1);
    assert.ok(warnings.some((line) => line.includes('exceed MAX_CANDIDATES')));
    assert.ok(logs.some((line) => line.includes('images_sent=5') && line.includes('api_calls=1') && line.includes('confirmed_assets=5')));
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    config.MAX_CANDIDATES = previousMax;
  }
});

test('findCandidates success releases the source video before Vision/finalization', async (t) => {
  const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'slideshow.mp4');
  if (!fs.existsSync(fixture)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const jobId = makeJobId('phase7-delete-video', 1);
  const videoPath = path.join(config.VIDEO_DIR, `${jobId}.mp4`);
  const assetDir = path.join(config.ASSET_DIR, jobId);
  const candidateDir = path.join(config.CANDIDATE_DIR, jobId);
  const previousKey = config.ANTHROPIC_API_KEY;
  await fs.promises.copyFile(fixture, videoPath);
  jobService.createJob(jobId, { sourceType: 'upload', duration: 43 });
  config.ANTHROPIC_API_KEY = 'test-key';
  vision.setClientForTests({ messages: { create: async (params) => {
    const count = params.messages[0].content.filter((block) => block.type === 'image').length;
    return {
      content: [{ type: 'tool_use', name: 'report_assets', input: {
        assets: Array.from({ length: count }, (_value, ref) => ({
          ref, isAsset: true, label: 'Test slide', description: 'A test slide.', confidence: 0.9,
        })),
      } }],
    };
  } } });
  try {
    await extractRoutes.runIngested(jobId, videoPath, 43);
    assert.equal(fs.existsSync(videoPath), false);
    assert.equal(jobService.getJob(jobId).status, 'done');
    assert.ok(jobService.getJob(jobId).assets.length > 0);
  } finally {
    vision.resetClientForTests();
    config.ANTHROPIC_API_KEY = previousKey;
    await fs.promises.rm(assetDir, { recursive: true, force: true });
    await fs.promises.rm(candidateDir, { recursive: true, force: true });
    await fs.promises.rm(videoPath, { force: true });
    jobService.removeJob(jobId);
  }
});

test('twenty mixed uploads leave no new multer staging orphans', async (t) => {
  const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4');
  if (!fs.existsSync(fixture)) {
    t.skip('sample.mp4 fixture is not available');
    return;
  }
  const bytes = await fs.promises.readFile(fixture);
  const initial = new Set((await fs.promises.readdir(config.UPLOAD_TMP_DIR)).sort());
  const app = express();
  app.post('/audit', (req, res) => upload.single('file')(req, res, async (multerError) => {
    if (multerError) {
      await removeTempUpload(req._uploadTempPath).catch(() => {});
      return res.status(400).json({ error: multerError.message });
    }
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    const jobId = makeJobId('phase7-upload-audit', req.file.originalname);
    try {
      const accepted = await ingestion.acceptUpload(jobId, req.file);
      await fs.promises.unlink(accepted.videoPath).catch(() => {});
      return res.status(200).json({ ok: true });
    } catch (error) {
      await removeTempUpload(req.file.path).catch(() => {});
      return res.status(400).json({ error: error.message });
    }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let index = 0; index < 20; index++) {
      const extension = index % 2 === 0 ? 'mp4' : 'txt';
      const form = new FormData();
      form.append('file', new Blob([bytes]), `phase7-audit-${index}.${extension}`);
      const response = await fetch(`${base}/audit`, { method: 'POST', body: form });
      assert.equal(response.status, extension === 'mp4' ? 200 : 400);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const final = new Set((await fs.promises.readdir(config.UPLOAD_TMP_DIR)).sort());
  assert.deepEqual(final, initial);
});

test('missing ffmpeg binary rejects promptly instead of hanging', async () => {
  const script = [
    "require('dotenv').config();",
    "const fs = require('fs'); const path = require('path');",
    "const config = require('./src/config'); const { createJob, getJob, removeJob } = require('./src/services/jobService');",
    "const route = require('./src/routes/extractRoutes');",
    "(async () => {",
    "const id = 'phase7-missing-ffmpeg-' + Date.now(); const source = path.join(config.UPLOAD_TMP_DIR, id + '.part');",
    "const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4'); fs.mkdirSync(config.UPLOAD_TMP_DIR, { recursive: true }); fs.copyFileSync(fixture, source);",
    "createJob(id, { sourceType: 'upload' }); await route.runUpload(id, { path: source, originalname: 'sample.mp4', size: fs.statSync(source).size });",
    "const job = getJob(id); console.log(JSON.stringify({ status: job.status, error: job.error }));",
    "await fs.promises.rm(path.join(config.VIDEO_DIR, id + '.mp4'), { force: true }); await fs.promises.rm(path.join(config.CANDIDATE_DIR, id), { recursive: true, force: true }); removeJob(id);",
    "})().catch((err) => { console.error(err); process.exit(3); });",
  ].join(' ');
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FFMPEG_PATH: 'phase7-binary-does-not-exist' },
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('missing binary rejection timed out'));
    }, 5000);
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, output);
  assert.match(output, /"status":"failed"/);
  assert.ok(/ENOENT|does-not-exist|not found/i.test(output));
  assert.ok(Date.now() - started < 5000);
});

test('hardening audit has no async forEach and protects private temp paths', () => {
  const srcRoot = path.join(__dirname, '..', 'src');
  const sourceFiles = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.js')) sourceFiles.push(full);
    }
  };
  visit(srcRoot);
  const source = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /forEach\s*\(\s*async/);
  assert.doesNotMatch(source, /express\.static\([^)]*(VIDEO_DIR|CANDIDATE_DIR|UPLOAD_TMP_DIR)/);
  const server = fs.readFileSync(path.join(srcRoot, 'server.js'), 'utf8');
  assert.match(server, /process\.on\('unhandledRejection'/);
  assert.match(server, /process\.on\('uncaughtException'/);
  assert.match(server, /startCleanupScheduler\(\)/);
});
