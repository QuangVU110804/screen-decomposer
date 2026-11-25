'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../../src/app');
const { createConfig } = require('../../src/config/index');
async function fixture(worker, status = async () => ({ ready: true, fingerprint: 'test-v1' })) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-'));
  const app = createApp({ config: createConfig({ dataDir: dir }), worker, status });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { app, dir, base: `http://127.0.0.1:${server.address().port}`, close: async () => { await app.locals.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); } };
}
async function upload(base) {
  const buffer = await sharp({ create: { width: 60, height: 40, channels: 4, background: '#cc4422' } }).png().toBuffer();
  const form = new FormData(); form.append('file', new Blob([buffer]), 'test.png');
  const response = await fetch(base + '/api/images', { method: 'POST', body: form });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}
async function wait(base, id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await fetch(base + '/api/jobs/' + id)).json();
    if (['done', 'partial', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}
test('upload -> scoped media and ZIP, cache hit, and label persistence', async () => {
  let calls = 0;
  const f = await fixture(async (config, request) => {
    calls++;
    await fs.mkdir(request.output, { recursive: true });
    await sharp(request.source).extract({ left: 5, top: 5, width: 20, height: 20 }).png().toFile(path.join(request.output, 'region_001.png'));
    return { elements: [{ id: 'region_001', file: 'region_001.png', thumbnail: 'region_001.png', label: 'Vùng ảnh', bbox: [5, 5, 20, 20], type: 'region', outputKind: 'mask', selected: true }], warnings: [], engines: { segmentation: { ok: true } } };
  });
  try {
    const first = await upload(f.base);
    const result = await wait(f.base, first.id);
    assert.equal(result.status, 'done'); assert.equal(result.elements.length, 1);
    assert.equal(JSON.stringify(result).includes(f.dir), false);
    const media = await fetch(f.base + result.elements[0].url); assert.equal(media.status, 200);
    const bad = await fetch(f.base + `/api/jobs/${first.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['../../secret'] }) });
    assert.equal(bad.status, 400);
    const zip = await fetch(f.base + `/api/jobs/${first.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['region_001'] }) });
    assert.equal(zip.status, 200); assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    const patch = await fetch(f.base + `/api/jobs/${first.id}/elements/region_001`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Nhân vật A', selected: false }) });
    assert.equal(patch.status, 200);
    assert.equal((await wait(f.base, first.id)).elements[0].label, 'Nhân vật A');
    const select=await fetch(f.base+`/api/jobs/${first.id}/selection`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['region_001'],selected:true})});
    assert.equal(select.status,200);assert.equal((await select.json()).elements[0].selected,true);
    const second = await upload(f.base); const cached = await wait(f.base, second.id);
    assert.equal(cached.cacheHit, true); assert.equal(calls, 1);
    assert.equal(cached.elements[0].label, 'Vùng ảnh');
    const firstFile = path.join(f.dir,'jobs',first.id,'elements','region_001.png');
    const secondFile = path.join(f.dir,'jobs',second.id,'elements','region_001.png');
    const before = await fs.stat(firstFile), after = await fs.stat(secondFile);
    assert.ok(before.nlink >= 3);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
  } finally { await f.close(); }
});
test('cancel frees queue; invalid images and cross-origin writes are rejected', async () => {
  const f = await fixture((config, request, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
  }));
  try {
    const first = await upload(f.base);
    const second = await upload(f.base);
    const response = await fetch(f.base + `/api/jobs/${first.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200); assert.equal((await wait(f.base, first.id)).status, 'canceled');
    await fetch(f.base + `/api/jobs/${second.id}/cancel`, { method: 'POST' });
    const form = new FormData(); form.append('file', new Blob(['bad']), 'fake.png');
    assert.equal((await fetch(f.base + '/api/images', { method: 'POST', body: form })).status, 400);
    assert.equal((await fetch(f.base + '/api/images', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally { await f.close(); }
});

test('a disconnected upload cannot enqueue expensive inference after preprocessing', async () => {
  let release, entered, calls = 0;
  const blocked = new Promise(resolve => release = resolve);
  const reached = new Promise(resolve => entered = resolve);
  const f = await fixture(async () => { calls++; }, async () => { entered(); await blocked; return { ready:true }; });
  try {
    const buffer = await sharp({create:{width:20,height:20,channels:3,background:'red'}}).png().toBuffer();
    const body = new FormData(); body.append('file',new Blob([buffer]),'image.png');
    const controller = new AbortController();
    const pending = fetch(f.base+'/api/images',{method:'POST',body,signal:controller.signal});
    await reached; controller.abort(); await assert.rejects(pending,{name:'AbortError'});
    await new Promise(resolve=>setTimeout(resolve,50)); release();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(calls,0); assert.equal(f.app.locals.store.list().length,0);
  } finally { release(); await f.close(); }
});
