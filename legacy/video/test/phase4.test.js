const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

require('dotenv').config();
const config = require('../src/config');
const { finalizeAssets } = require('../src/services/assetExtractionService');

const source = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'bars.png');

function makeAssets(count) {
  return Array.from({ length: count }, (_value, index) => ({
    label: `Asset ${index + 1}`,
    description: `Description ${index + 1}.`,
    confidence: 0.8,
    timestamp: index + 1,
    framePath: source,
  }));
}

async function clean(jobId) {
  await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
}

test('finalizeAssets sorts, copies lossless PNGs, thumbnails and manifest', async (t) => {
  if (!fs.existsSync(source)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const jobId = `phase4-basic-${Date.now()}`;
  const unsorted = makeAssets(4).reverse();
  unsorted[0].timestamp = 0;
  unsorted[1].timestamp = 3;
  unsorted[2].timestamp = 1;
  unsorted[3].timestamp = 2;
  try {
    const finalized = await finalizeAssets({ id: jobId, sourceType: 'upload', assets: unsorted });
    assert.deepEqual(finalized.assets.map((asset) => asset.timestamp), [0, 1, 2, 3]);
    const finalDir = path.join(config.ASSET_DIR, jobId);
    for (let index = 1; index <= 4; index++) {
      const base = `asset_${String(index).padStart(3, '0')}`;
      const png = path.join(finalDir, `${base}.png`);
      const thumb = path.join(finalDir, `${base}_thumb.jpg`);
      assert.deepEqual(await fs.promises.readFile(png), await fs.promises.readFile(source));
      const metadata = await sharp(thumb).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.ok(metadata.width <= 320);
    }
    const manifest = JSON.parse(await fs.promises.readFile(path.join(finalDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.assetCount, 4);
    assert.equal(manifest.assets.length, 4);
    assert.ok(manifest.assets.every((asset) => !path.isAbsolute(asset.file) && !path.isAbsolute(asset.thumb)));
  } finally {
    await clean(jobId);
  }
});

test('finalizeAssets is idempotent when the asset list shrinks', async (t) => {
  if (!fs.existsSync(source)) {
    t.skip('Phase 2 fixtures are not available');
    return;
  }
  const jobId = `phase4-idempotent-${Date.now()}`;
  const job = { id: jobId, sourceType: 'upload', assets: makeAssets(5) };
  try {
    await finalizeAssets(job);
    job.assets = job.assets.slice(0, 4);
    const second = await finalizeAssets(job);
    const files = (await fs.promises.readdir(path.join(config.ASSET_DIR, jobId))).sort();
    assert.equal(second.assets.length, 4);
    assert.equal(files.includes('asset_005.png'), false);
    assert.deepEqual(files, [
      'asset_001.png', 'asset_001_thumb.jpg',
      'asset_002.png', 'asset_002_thumb.jpg',
      'asset_003.png', 'asset_003_thumb.jpg',
      'asset_004.png', 'asset_004_thumb.jpg',
      'manifest.json',
    ]);
  } finally {
    await clean(jobId);
  }
});

test('empty assets produce a valid empty manifest', async () => {
  const jobId = `phase4-empty-${Date.now()}`;
  try {
    const finalized = await finalizeAssets({ id: jobId, sourceType: 'youtube', assets: [] });
    assert.deepEqual(finalized.assets, []);
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(config.ASSET_DIR, jobId, 'manifest.json'), 'utf8')
    );
    assert.equal(manifest.assetCount, 0);
  } finally {
    await clean(jobId);
  }
});

test('corrupt candidate fails cleanly and does not leave a final directory', async () => {
  const jobId = `phase4-corrupt-${Date.now()}`;
  const corrupt = path.join(config.TEMP_DIR, `${jobId}.png`);
  await fs.promises.writeFile(corrupt, '');
  try {
    await assert.rejects(
      finalizeAssets({ id: jobId, assets: [{ timestamp: 1, framePath: corrupt }] }),
      /Input (?:buffer|file) contains unsupported image format|corrupt|empty/i
    );
    assert.equal(fs.existsSync(path.join(config.ASSET_DIR, jobId)), false);
  } finally {
    await fs.promises.unlink(corrupt).catch(() => {});
    await clean(jobId);
  }
});
