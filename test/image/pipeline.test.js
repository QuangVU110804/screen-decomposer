'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createConfig } = require('../../src/config/index');
const { createStore } = require('../../src/features/jobs/store');
const { createPipeline, jobDir } = require('../../src/features/elements/pipeline');
const { pruneCache } = require('../../src/features/elements/cache');
async function setup(budget) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
  const config = { ...createConfig({ dataDir: dir }), ...(budget ? { maxArtifactBytes: budget } : {}) };
  const store = createStore(config), id = crypto.randomUUID(), output = path.join(jobDir(config,id),'elements');
  await fs.mkdir(output, { recursive: true });
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: 'red' } }).png().toBuffer();
  await fs.writeFile(path.join(jobDir(config,id), 'source.png'), png);
  await fs.writeFile(path.join(jobDir(config,id), 'preview.webp'), png);
  store.put({ id, source: { hash: 'source', width:20, height:20 }, preset:'fast', engineFingerprint:'v1', status:'queued', elements:[] });
  return { config, store, id, output, png, close:async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});} };
}
const element = { id:'region_001', file:'region_001.png', thumbnail:'region_001.png', label:'Vùng ảnh', bbox:[0,0,20,20], outputKind:'mask', selected:true };
test('cache-only disk failure preserves successful assets and downloadable state', async () => {
  const f = await setup(); const link = fs.link;
  try {
    const worker = async()=>{await fs.writeFile(path.join(f.output,element.file),f.png);return {elements:[element],warnings:[],engines:{segmentation:{ok:true}}};};
    fs.link = async (source,target)=>{if(target.includes(`${path.sep}cache${path.sep}`))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return link(source,target);};
    await createPipeline({...f,worker})(f.id,new AbortController().signal);
    assert.ok(['done','partial'].includes(f.store.get(f.id).status), JSON.stringify(f.store.get(f.id)));
    assert.equal(f.store.get(f.id).elements.length,1);
    assert.ok(f.store.get(f.id).cacheWarning);
  } finally { fs.link=link;await f.close(); }
});
test('cache cleanup evicts expired and oldest entries while linked assets remain available', async () => {
  const f = await setup();
  try {
    const config = { ...f.config, maxCacheBytes: f.png.length, retentionMs: 86_400_000 };
    const now = Date.now();
    const source = path.join(f.output,element.file);
    await fs.writeFile(source,f.png);
    for (const [key,age] of [['a',100_000_000],['b',5000],['c',1000]]) {
      const dir = path.join(config.dataDir,'cache',key.repeat(64));
      await fs.mkdir(dir,{recursive:true});
      await fs.link(source,path.join(dir,element.file));
      await fs.utimes(dir,new Date(now-age),new Date(now-age));
    }
    await fs.mkdir(path.join(config.dataDir,'cache','d'.repeat(64)+'.'+f.id));
    await pruneCache(config);
    assert.deepEqual(await fs.readdir(path.join(config.dataDir,'cache')),['c'.repeat(64)]);
    assert.deepEqual(await fs.readFile(source),f.png);
  } finally { await f.close(); }
});
test('a failed cache restore unlinks restored artifacts before the worker writes', async () => {
  const f = await setup(); const link = fs.link;
  try {
    const second = {...element,id:'region_002',file:'region_002.png',thumbnail:'region_002.png'};
    let calls = 0;
    const changed = Buffer.concat([f.png,Buffer.from('new generation')]);
    const worker = async () => {
      const buffer = ++calls === 1 ? f.png : changed;
      for (const item of [element,second]) await fs.writeFile(path.join(f.output,item.file),buffer);
      return {elements:[element,second],warnings:[],engines:{segmentation:{ok:true}}};
    };
    const run = createPipeline({...f,worker});
    await run(f.id,new AbortController().signal);
    const original = path.join(f.config.dataDir,'old-job.png');
    await fs.link(path.join(f.output,element.file),original);
    fs.link = async (source,target) => {
      if (target === path.join(f.output,second.file)) throw Object.assign(new Error('broken cache link'),{code:'EIO'});
      return link(source,target);
    };
    await run(f.id,new AbortController().signal);
    assert.equal(calls,2);
    assert.deepEqual(await fs.readFile(original),f.png);
    assert.deepEqual(await fs.readFile(path.join(f.output,element.file)),changed);
  } finally { fs.link=link;await f.close(); }
});
test('canceling during cache lookup does not start the worker', async () => {
  const f = await setup();
  const read = fs.readFile;
  const controller = new AbortController();
  let calls = 0;
  try {
    fs.readFile = async (file, ...args) => {
      if (String(file).includes(`${path.sep}cache${path.sep}`)) controller.abort();
      return read(file, ...args);
    };
    const worker = async () => { calls++; throw new Error('unexpected worker'); };
    await createPipeline({...f,worker})(f.id,controller.signal);
    assert.equal(calls,0);
    assert.equal(f.store.get(f.id).status,'canceled');
  } finally { fs.readFile=read;await f.close(); }
});
test('artifact limit removes orphan output and retains valid elements as partial', async () => {
  const f = await setup(5000);
  try {
    const worker = async()=>{
      await fs.writeFile(path.join(f.output,element.file),f.png);
      await fs.writeFile(path.join(f.output,'region_099.png'),Buffer.alloc(20000));
      return {elements:[element],warnings:[],engines:{segmentation:{ok:true}}};
    };
    await createPipeline({...f,worker})(f.id,new AbortController().signal);
    assert.equal(f.store.get(f.id).status,'partial', JSON.stringify(f.store.get(f.id)));
    assert.equal(f.store.get(f.id).elements.length,1);
    await assert.rejects(fs.stat(path.join(f.output,'region_099.png')),/ENOENT/);
  } finally { await f.close(); }
});

test('a changed engine fingerprint invalidates source-image cache', async () => {
  const f=await setup();let calls=0;
  try {
    const worker=async()=>{calls++;await fs.writeFile(path.join(f.output,element.file),f.png);return {elements:[element],warnings:[],engines:{segmentation:{ok:true}}};};
    const run=createPipeline({...f,worker});
    await run(f.id,new AbortController().signal);
    f.store.put({...f.store.get(f.id),engineFingerprint:'v2'});
    await run(f.id,new AbortController().signal);
    assert.equal(calls,2);assert.equal(f.store.get(f.id).cacheHit,false);
  }finally{await f.close();}
});

test('interrupted segmentation retains valid checkpoint masks even when OCR failed',async()=>{
  const f=await setup();
  try{
    const worker=async()=>{
      await fs.writeFile(path.join(f.output,element.file),f.png);
      await fs.writeFile(path.join(f.output,'result.json'),JSON.stringify({elements:[element],warnings:['OCR unavailable'],engines:{text:{ok:false},segmentation:{ok:false,incomplete:true}}}));
      throw new Error('segmentation timeout');
    };
    await createPipeline({...f,worker})(f.id,new AbortController().signal);
    const job=f.store.get(f.id);assert.equal(job.status,'partial',JSON.stringify(job));assert.equal(job.elements.length,1);
    assert.equal(job.engines.segmentation.ok,false);assert.equal(job.engines.segmentation.incomplete,true);
  }finally{await f.close();}
});
test('region elements with a sourceFile validate and export without leaking the source crop', async () => {
  const f = await setup();
  try {
    const region = { ...element, sourceFile: 'region_001.source.png', sourcePixelsOnly: false };
    const worker = async () => { for (const n of [region.file, region.sourceFile]) await fs.writeFile(path.join(f.output, n), f.png); return { elements: [region], warnings: [], engines: { segmentation: { ok: true } } }; };
    await createPipeline({ ...f, worker })(f.id, new AbortController().signal);
    const job = f.store.get(f.id);
    assert.ok(['done', 'partial'].includes(job.status), JSON.stringify(job));
    assert.equal(job.elements[0].sourceFile, 'region_001.source.png');
    const chunks = [], res = new (require('node:stream').PassThrough)();
    res.attachment = () => {}; res.on('data', c => chunks.push(c));
    require('../../src/features/elements/export').streamExport(job, ['region_001'], f.output, res);
    await new Promise(r => res.on('end', r));
    const zip = Buffer.concat(chunks);
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    assert.ok(zip.includes('assets/region_001.png'));
    assert.equal(zip.includes('region_001.source.png'), false);
  } finally { await f.close(); }
});
test('a worker stopped during the tile pass keeps its checkpoint elements as partial', async () => {
  const f = await setup();
  try {
    const seen = [];
    const worker = async (config, request, { onEvent }) => {
      await fs.writeFile(path.join(f.output, element.file), f.png);
      await fs.writeFile(path.join(f.output, 'result.json'), JSON.stringify({ elements: [element], warnings: [], engines: { text: { ok: true }, segmentation: { ok: false, incomplete: true } } }));
      onEvent({ type: 'stage', stage: 'tiles' }); seen.push(f.store.get(f.id).progress);
      onEvent({ type: 'progress', completed: 1, total: 2, count: 1 }); seen.push(f.store.get(f.id).progress);
      throw new Error('segmentation timeout');
    };
    await createPipeline({ ...f, worker })(f.id, new AbortController().signal);
    assert.deepEqual(seen, [75, 83]);
    const job = f.store.get(f.id);
    assert.equal(job.status, 'partial', JSON.stringify(job));
    assert.deepEqual(job.elements.map(e => e.id), ['region_001']);
    await fs.stat(path.join(f.output, element.file));
  } finally { await f.close(); }
});
