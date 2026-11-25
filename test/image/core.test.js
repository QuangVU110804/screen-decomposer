'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { createConfig } = require('../../src/config/index');
const { normalizeImage } = require('../../src/features/images/normalize');
const { createStore } = require('../../src/features/jobs/store');
const { scopedPath } = require('../../src/shared/files');

test('decoder validates pixels and format and preserves original alpha', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elements-'));
  try {
    const config = createConfig({ dataDir: dir, maxPixels: 500 });
    const input = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#ff000080' } }).png().toBuffer();
    const result = await normalizeImage(input, dir, config);
    const { data, info } = await sharp(result.source).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.ok(data[3] >= 127 && data[3] <= 129);
    await assert.rejects(normalizeImage(Buffer.from('not an image'), dir, config), /ảnh|image/i);
    const big = await sharp({ create: { width: 30, height: 30, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(normalizeImage(big, dir, config), /pixel|kích thước/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('EXIF rotation returns normalized coordinates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elements-'));
  try {
    const input = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const image = await normalizeImage(input, dir, createConfig({ dataDir: dir }));
    assert.equal(image.width, 20); assert.equal(image.height, 30);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('animated PNG is rejected even when decoder omits page metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elements-'));
  const apng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAGQD6AAAAVWPHQAAABVJREFUeJxj/M/A8J+BgYGBCUSAMAAfFwICAkezFAAAABpmY1RMAAAAAQAAAAIAAAACAAAAAAAAAAAAZAPoAACaJmXJAAAAGWZkQVQAAAACeJxjZGD4/5+BgYGBCUSAMAAdGQICRW6eVwAAAABJRU5ErkJggg==', 'base64');
  try { await assert.rejects(normalizeImage(apng, dir, createConfig({ dataDir: dir })), /ảnh tĩnh|animation/i); }
  finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('store recovers interrupted jobs without modifying completed results', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elements-'));
  const config = createConfig({ dataDir: dir });
  let store = createStore(config);
  store.put({ id: 'a', status: 'running', elements: [] });
  store.put({ id: 'b', status: 'done', elements: [{ id: 'kept' }] });
  store.close(); store = createStore(config);
  assert.equal(store.get('a').status, 'failed');
  assert.equal(store.get('b').elements[0].id, 'kept');
  store.close(); await fs.rm(dir, { recursive: true, force: true });
});

test('scoped file resolution rejects traversal and siblings', () => {
  assert.throws(() => scopedPath(path.resolve('temp/root'), '../root2/secret'), /path|đường dẫn/i);
  assert.throws(() => scopedPath(path.resolve('temp/root'), '../secret'), /path|đường dẫn/i);
  assert.equal(scopedPath(path.resolve('temp/root'), 'assets/a.png'), path.resolve('temp/root/assets/a.png'));
});
