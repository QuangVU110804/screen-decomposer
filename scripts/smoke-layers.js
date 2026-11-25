'use strict';
// Controlled overlap QA using real, already-extracted reference assets. No inference is run.
// Usage: node scripts/smoke-layers.js <completed-job-id> [http://127.0.0.1:3000]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results/layers-text-v2/overlap');
const zipFile = path.join(root, 'test-results/layers-text-v2/overlap-native.zip');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function pixels(bytes) {
  return sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function describe(bytes) {
  const decoded = await pixels(bytes);
  return { width: decoded.info.width, height: decoded.info.height, pngSha256: hash(bytes), rgbaSha256: hash(decoded.data) };
}
async function main() {
  const jobId = process.argv[2];
  if (!/^[0-9a-f-]{36}$/.test(jobId || '')) throw new Error('Usage: node scripts/smoke-layers.js <completed-job-id> [http://127.0.0.1:3000]');
  const base = new URL(process.argv[3] || 'http://127.0.0.1:3000');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Use a localhost HTTP origin.');
  const api = `/api/jobs/${jobId}`;
  const report = {
    status: 'running', jobId, base: base.origin, startedAt: new Date().toISOString(),
    scenario: 'Controlled overlap made from two real extracted reference assets. Full B comes from importing its original PNG; this does not reconstruct pixels hidden in a flattened image.',
    sourceB: 'test-results/quality/whole-character.png', sourceA: 'test-results/quality/sun-complete.png',
    placementB: { x: 300, y: 100 }, placementA: { x: 350, y: 180 }, checks: {},
  };
  async function json(route, method = 'GET', body) {
    const response = await fetch(base.origin + api + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${text}`);
    return JSON.parse(text);
  }
  function safeMedia(url) {
    assert.equal(typeof url, 'string');
    assert.ok(url.startsWith(api + '/media/'), 'Media must remain scoped to the current job');
    const suffix = url.slice((api + '/media/').length);
    assert.match(suffix, /^(region|text)_\d{3}-(image|thumb|mask|edit-source|edit-mask)(\?revision=\d+)?$/);
    return base.origin + url;
  }
  async function media(url) {
    const response = await fetch(safeMedia(url));
    assert.equal(response.status, 200, `Media fetch failed: ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async function save(name, bytes) { await fs.writeFile(path.join(output, name), bytes); }
  async function saveJson(name, value) { await save(name, JSON.stringify(value, null, 2)); }
  async function importAsset(bytes, filename, label, placement, previousIds) {
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
    form.append('label', label); form.append('x', String(placement.x)); form.append('y', String(placement.y));
    const response = await fetch(base.origin + api + '/layers', { method: 'POST', body: form });
    const text = await response.text(); assert.equal(response.status, 200, text);
    const job = JSON.parse(text), added = job.elements.filter(e => !previousIds.has(e.id));
    assert.equal(added.length, 1, 'Import must create exactly one new layer');
    return { job, element: added[0] };
  }
  async function edit(id) {
    const value = await json(`/elements/${id}/edit`);
    for (const url of [value.sourceUrl, value.maskUrl, value.previewUrl]) safeMedia(url);
    assert.equal('sourceFile' in value.element, false); assert.equal('initialFile' in value.element, false);
    const mask = await media(value.maskUrl), metadata = await sharp(mask).metadata();
    assert.equal(metadata.width, value.width); assert.equal(metadata.height, value.height);
    return value;
  }
  await fs.mkdir(output, { recursive: true });
  try {
    let job = await json('');
    assert.ok(['done', 'partial'].includes(job.status), 'An existing completed job is required');
    assert.ok(job.elements.length <= 78, 'Two free layer slots are required');
    const originalIds = new Set(job.elements.map(e => e.id));
    const [originalB, originalA] = await Promise.all([fs.readFile(path.join(root, report.sourceB)), fs.readFile(path.join(root, report.sourceA))]);
    const [sourceB, sourceA] = await Promise.all([pixels(originalB), pixels(originalA)]);
    report.inputB = await describe(originalB); report.inputA = await describe(originalA);
    await Promise.all([save('source-B.png', originalB), save('source-A.png', originalA)]);
    report.stage = 'import B';
    const first = await importAsset(originalB, 'whole-character.png', 'B — original complete character', report.placementB, originalIds);
    const bId = first.element.id;
    report.stage = 'import A';
    const second = await importAsset(originalA, 'sun-complete.png', 'A — original sun overlap', report.placementA, new Set(first.job.elements.map(e => e.id)));
    const aId = second.element.id; report.layerB = bId; report.layerA = aId; job = second.job;
    assert.deepEqual(first.element.bbox.slice(2), [sourceB.info.width, sourceB.info.height]);
    assert.deepEqual(second.element.bbox.slice(2), [sourceA.info.width, sourceA.info.height]);
    job = await json('/layers', 'PATCH', { layers: job.elements.map((e, index) => ({ id: e.id, x: e.id === bId ? 300 : e.id === aId ? 350 : e.placement?.x ?? e.bbox[0], y: e.id === bId ? 100 : e.id === aId ? 180 : e.placement?.y ?? e.bbox[1], visible: e.id === bId || e.id === aId, order: e.id === bId ? 0 : e.id === aId ? 1 : index + 2 })) });
    const baselineEdit = await edit(bId), baselineB = await media(baselineEdit.previewUrl);
    const immutableA = await media(job.elements.find(e => e.id === aId).url), aHash = hash(immutableA);
    assert.deepEqual((await pixels(baselineB)).data, sourceB.data, 'Imported B pixels must equal the original RGBA');
    assert.deepEqual((await pixels(await media(baselineEdit.sourceUrl))).data, sourceB.data, 'Editor source must retain original B RGBA');
    assert.deepEqual((await pixels(immutableA)).data, sourceA.data, 'Imported A pixels must equal the original RGBA');
    await Promise.all([save('B-baseline.png', baselineB), save('A-unchanged.png', immutableA)]);
    // Rectangle of the placed A/B bounding-box intersection, expressed in native B-local pixels.
    const left = Math.max(0, report.placementA.x - report.placementB.x), top = Math.max(0, report.placementA.y - report.placementB.y);
    const right = Math.min(sourceB.info.width, report.placementA.x + sourceA.info.width - report.placementB.x);
    const bottom = Math.min(sourceB.info.height, report.placementA.y + sourceA.info.height - report.placementB.y);
    assert.ok(right > left && bottom > top, 'The two real assets must overlap');
    const polygon = [[left, top], [right, top], [right, bottom], [left, bottom]];
    report.polygonBLocal = polygon;
    report.polygonMeaning = 'Bounding-box overlap rectangle; it intentionally does not infer the foreground silhouette or hidden source pixels.';
    const width = Math.max(300 + sourceB.info.width, 350 + sourceA.info.width) + 40;
    const height = Math.max(100 + sourceB.info.height, 180 + sourceA.info.height) + 40;
    async function layout(bBytes) {
      return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: bBytes, left: 300, top: 100 }, { input: immutableA, left: 350, top: 180 }]).png().toBuffer();
    }
    report.stage = 'erase overlap from B';
    job = await json(`/elements/${bId}/mask`, 'POST', { revision: baselineEdit.revision, operations: [{ kind: 'polygon', mode: 'erase', points: polygon }] });
    const erasedB = await media(job.elements.find(e => e.id === bId).url), erasedPixels = (await pixels(erasedB)).data;
    let erasedVisiblePixels = 0;
    for (let i = 3; i < sourceB.data.length; i += 4) if (sourceB.data[i] > 0 && erasedPixels[i] === 0) erasedVisiblePixels++;
    assert.ok(erasedVisiblePixels > 0, 'Erase must remove actual visible B pixels');
    report.erasedVisiblePixels = erasedVisiblePixels;
    await Promise.all([save('B-erased.png', erasedB), save('layout-before.png', await layout(erasedB)), saveJson('state-before.json', job)]);
    report.stage = 'restore B from original imported source';
    const erasedRevision = job.elements.find(e => e.id === bId).editRevision;
    job = await json(`/elements/${bId}/mask`, 'POST', { revision: erasedRevision, operations: [{ kind: 'polygon', mode: 'add', points: polygon }] });
    const restoredB = await media(job.elements.find(e => e.id === bId).url);
    assert.deepEqual((await pixels(restoredB)).data, sourceB.data, 'Restored complete B must equal source original RGBA');
    assert.equal(hash(await media(job.elements.find(e => e.id === aId).url)), aHash, 'Editing B must leave A PNG unchanged');
    await save('B-restored.png', restoredB);
    report.checks.restoredBMatchesOriginalRgba = true; report.checks.aPngUnchanged = true;
    const restoredRevision = job.elements.find(e => e.id === bId).editRevision;
    const stale = await fetch(base.origin + api + `/elements/${bId}/mask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: erasedRevision, operations: [{ kind: 'polygon', mode: 'erase', points: polygon }] }) });
    assert.equal(stale.status, 409, await stale.text()); report.checks.staleRevisionRejected = true;
    report.stage = 'reset B to immutable initial import';
    job = await json(`/elements/${bId}/reset-mask`, 'POST', { revision: restoredRevision });
    const finalEdit = await edit(bId), finalB = await media(finalEdit.previewUrl);
    assert.deepEqual(finalB, baselineB, 'Reset must return the immutable initial imported PNG bytes');
    assert.deepEqual((await pixels(finalB)).data, sourceB.data);
    assert.equal(hash(await media(job.elements.find(e => e.id === aId).url)), aHash);
    assert.deepEqual(job.elements.find(e => e.id === bId).placement, report.placementB);
    assert.deepEqual(job.elements.find(e => e.id === aId).placement, report.placementA);
    assert.deepEqual(job.elements.filter(e => e.layerVisible !== false).map(e => e.id).sort(), [bId, aId].sort());
    report.checks.resetMatchesInitialPng = true; report.checks.nativeDimensionsPreserved = true; report.checks.onlyImportedLayersVisible = true; report.checks.scopedEditMedia = true;
    await Promise.all([save('B-final.png', finalB), save('layout-after.png', await layout(finalB)), saveJson('state-after.json', job)]);
    report.stage = 'native ZIP export';
    const exported = await fetch(base.origin + api + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [bId, aId] }) });
    assert.equal(exported.status, 200, 'Native export must succeed');
    const zip = Buffer.from(await exported.arrayBuffer()); assert.equal(zip.subarray(0, 2).toString(), 'PK');
    await fs.writeFile(zipFile, zip);
    report.finalB = await describe(finalB); report.finalA = await describe(immutableA); report.baselineB = await describe(baselineB); report.erasedB = await describe(erasedB);
    report.revisions = { initial: baselineEdit.revision, erased: erasedRevision, restored: restoredRevision, final: finalEdit.revision };
    report.layout = { width, height, order: [bId, aId], background: 'transparent', sourcePixelsResampled: false };
    report.export = { path: path.relative(root, zipFile), ids: [bId, aId], bytes: zip.length, sha256: hash(zip) };
    report.checks.zipExportSucceeded = true; report.status = 'passed'; report.stage = 'complete'; report.finishedAt = new Date().toISOString();
    await saveJson('report.json', report);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Artifacts: ${output}\nZIP: ${zipFile}`);
  } catch (error) {
    report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString();
    await saveJson('report.json', report); throw error;
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
