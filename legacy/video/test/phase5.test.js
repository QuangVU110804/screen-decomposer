const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const sharp = require('sharp');

require('dotenv').config();
const config = require('../src/config');
const assetRoutes = require('../src/routes/assetRoutes');
const { createJob } = require('../src/services/jobService');
const { serializeJob } = require('../src/utils/serialize');

const source = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'bars.png');

function uuid(seed) {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function makeApp() {
  const app = express();
  app.use('/', assetRoutes);
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function makeAssetJob(seed, status = 'done') {
  const id = uuid(seed);
  const dir = path.join(config.ASSET_DIR, id);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  if (status === 'done') {
    await fs.promises.copyFile(source, path.join(dir, 'asset_001.png'));
    await sharp(source).resize({ width: 320 }).jpeg().toFile(path.join(dir, 'asset_001_thumb.jpg'));
    await fs.promises.writeFile(path.join(dir, 'manifest.json'), '{"assetCount":1}', 'utf8');
  }
  const job = createJob(id, {
    status,
    sourceType: 'upload',
    originalFilename: 'bars.png',
    assets: status === 'done' ? [{
      index: 1,
      label: 'Color slide',
      description: 'A color slide.',
      confidence: 0.9,
      timestamp: 3,
      timecode: '00:03',
      framePath: path.join(dir, 'asset_001.png'),
      thumbPath: path.join(dir, 'asset_001_thumb.jpg'),
    }] : [],
  });
  return job;
}

async function cleanupJob(job) {
  await fs.promises.rm(path.join(config.ASSET_DIR, job.id), { recursive: true, force: true });
}

test('serializeJob strips filesystem paths and exposes public asset URLs', async (t) => {
  if (!fs.existsSync(source)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const job = await makeAssetJob(501);
  try {
    const serialized = serializeJob(job);
    const json = JSON.stringify(serialized);
    assert.equal(json.includes('temp\\'), false);
    assert.equal(json.includes('temp/'), false);
    assert.equal(json.includes('framePath'), false);
    assert.deepEqual(serialized.assets[0], {
      index: 1,
      label: 'Color slide',
      description: 'A color slide.',
      confidence: 0.9,
      timestamp: 3,
      timecode: '00:03',
      url: `/assets/${job.id}/asset_001.png`,
      thumbUrl: `/assets/${job.id}/asset_001_thumb.jpg`,
      clipUrl: null,
      clipThumbUrl: null,
      clipDuration: 0,
    });
  } finally {
    await cleanupJob(job);
  }
});

test('asset route serves allowlisted files and blocks traversal/non-allowlisted names', async (t) => {
  if (!fs.existsSync(source)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const job = await makeAssetJob(502);
  const { server, base } = await listen(makeApp());
  try {
    const png = await fetch(`${base}/assets/${job.id}/asset_001.png`);
    assert.equal(png.status, 200);
    assert.match(png.headers.get('content-type'), /image\/png/);
    const jpg = await fetch(`${base}/assets/${job.id}/asset_001_thumb.jpg`);
    assert.equal(jpg.status, 200);
    assert.match(jpg.headers.get('content-type'), /image\/jpeg/);
    for (const url of [
      `${base}/assets/${job.id}/manifest.json`,
      `${base}/assets/not-a-uuid/asset_001.png`,
      `${base}/assets/${job.id}/%2e%2e%2fpackage.json`,
      `${base}/assets/${job.id}/asset_999.png`,
    ]) {
      const response = await fetch(url);
      assert.ok([400, 404].includes(response.status), `${url} -> ${response.status}`);
    }
  } finally {
    server.close();
    await cleanupJob(job);
  }
});

test('asset/job API semantics cover done, pending, unknown, list, config and zip', async (t) => {
  if (!fs.existsSync(source)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const doneJob = await makeAssetJob(503, 'done');
  const pendingJob = await makeAssetJob(504, 'sampling');
  const { server, base } = await listen(makeApp());
  try {
    const doneAssets = await fetch(`${base}/api/jobs/${doneJob.id}/assets`);
    assert.equal(doneAssets.status, 200);
    assert.equal((await doneAssets.json()).count, 1);
    const pendingAssets = await fetch(`${base}/api/jobs/${pendingJob.id}/assets`);
    assert.equal(pendingAssets.status, 409);
    const pendingBody = await pendingAssets.json();
    assert.equal(pendingBody.status, 'sampling');
    assert.equal((await fetch(`${base}/api/jobs/not-found/assets`)).status, 404);

    const zip = await fetch(`${base}/api/jobs/${doneJob.id}/download`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-type'), /zip/);
    const zipBuffer = Buffer.from(await zip.arrayBuffer());
    assert.ok(zipBuffer.includes(Buffer.from('asset_001.png')));
    assert.ok(zipBuffer.includes(Buffer.from('manifest.json')));

    const configResponse = await fetch(`${base}/api/config`);
    const configBody = await configResponse.json();
    assert.deepEqual(Object.keys(configBody).sort(), ['allowedExtensions', 'authRequired', 'maxDurationSec', 'maxUploadMb']);
    assert.equal(JSON.stringify(configBody).includes('ANTHROPIC'), false);

    const jobsResponse = await fetch(`${base}/api/jobs`);
    const jobsBody = await jobsResponse.json();
    assert.ok(Array.isArray(jobsBody.jobs));
    assert.ok(jobsBody.jobs.some((item) => item.id === doneJob.id && item.assetCount === 1));
    assert.equal((await fetch(`${base}/api/jobs/not-found/download`)).status, 404);

    await cleanupJob(doneJob);
    const missingDir = await fetch(`${base}/api/jobs/${doneJob.id}/download`);
    assert.equal(missingDir.status, 404);
  } finally {
    server.close();
    await cleanupJob(doneJob);
    await cleanupJob(pendingJob);
  }
});
