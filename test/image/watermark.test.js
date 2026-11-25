'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const http = require('node:http');
const { runWorker } = require('../../src/integrations/python/worker');
const { createApp } = require('../../src/app');
const { createConfig } = require('../../src/config/index');

async function fixture(watermarkWorker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watermark-api-'));
  const app = createApp({config:createConfig({dataDir:dir}), watermarkWorker});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {app, dir, base:`http://127.0.0.1:${server.address().port}`, close:async()=>{
    await app.locals.close(); await new Promise(resolve=>server.close(resolve));
    await fs.rm(dir, {recursive:true,force:true});
  }};
}
async function image() {
  return sharp({create:{width:100,height:80,channels:4,background:{r:35,g:95,b:160,alpha:0.6}}})
    .composite([{input:await sharp({create:{width:8,height:6,channels:4,background:'white'}}).png().toBuffer(),left:12,top:12}]).png().toBuffer();
}
test('detection returns normalized coordinates and leaves no files for a plain image', async () => {
  const f = await fixture();
  try {
    const source = await sharp({create:{width:100,height:160,channels:3,background:'#385671'}})
      .jpeg().withMetadata({orientation:6}).toBuffer();
    const form = new FormData();
    form.append('file', new Blob([source]), 'rotated.jpg');
    const response = await fetch(f.base + '/api/watermark/detect', {method:'POST',body:form});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{width:160,height:100,suggestions:[],warnings:[]});
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')),[]);
  } finally { await f.close(); }
});
function send(f, buffer, regions, options={}) {
  const form = new FormData(); form.append('file',new Blob([buffer]),'sample.png');
  form.append('regions', typeof regions==='string'?regions:JSON.stringify(regions));
  return fetch(f.base+'/api/watermark/remove',{method:'POST',body:form,...options});
}

test('real CPU removal returns native PNG, preserves outside RGBA and deletes temporary files', async()=>{
  const f=await fixture();
  try {
    const source=await image(), response=await send(f,source,[[10,10,12,10]]);
    assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('content-type'),/image\/png/);
    assert.match(response.headers.get('cache-control'),/no-store/);
    const output=await sharp(Buffer.from(await response.arrayBuffer())).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const original=await sharp(source).ensureAlpha().raw().toBuffer();
    assert.equal(output.info.width,100); assert.equal(output.info.height,80);
    let changed=0;
    for(let y=0;y<80;y++)for(let x=0;x<100;x++) {
      const i=(y*100+x)*4;
      assert.equal(output.data[i+3],original[i+3]);
      if(x<10||x>=22||y<10||y>=20)assert.deepEqual(output.data.subarray(i,i+4),original.subarray(i,i+4));
      else if(!output.data.subarray(i,i+3).equals(original.subarray(i,i+3)))changed++;
    }
    assert.ok(changed>30,'the mark must actually change');
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')),[]);
    assert.equal(f.app.locals.store.list().length,0,'removal needs no segmentation job');
  }finally{await f.close();}
});

test('invalid masks, files and cross-origin writes fail with no temporary residue',async()=>{
  const f=await fixture();
  try{
    const source=await image();
    for(const regions of [[],[[99,0,2,2]],[[0,0,-1,5]],[[0.5,0,1,1]],[[false,0,1,1]],[[0,0,50,50]],Array(21).fill([0,0,1,1]),'broken','null']) {
      const response=await send(f,source,regions); assert.equal(response.status,400,await response.text());
    }
    const bad=await send(f,Buffer.from('not an image'),[[1,1,2,2]]); assert.equal(bad.status,400);
    const denied=await send(f,source,[[1,1,2,2]],{headers:{Origin:'https://other.example'}}); assert.equal(denied.status,403);
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')).catch(()=>[]),[]);
  }finally{await f.close();}
});

test('EXIF orientation is normalized before native coordinate validation',async()=>{
  const f=await fixture();
  try{
    const source=await sharp({create:{width:60,height:100,channels:3,background:'navy'}}).jpeg().withMetadata({orientation:6}).toBuffer();
    const response=await send(f,source,[[85,40,10,8]]);
    assert.equal(response.status,200,await response.clone().text());
    const meta=await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(meta.width,100);assert.equal(meta.height,60);
  }finally{await f.close();}
});

test('disconnect aborts the worker; busy requests fail and the next request can proceed',async()=>{
  let started, aborted, calls=0;
  const entered=new Promise(resolve=>started=resolve), stopped=new Promise(resolve=>aborted=resolve);
  const f=await fixture((config,request,{signal})=>{
    if(calls++)return runWorker(config,request,{signal});
    return new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>{aborted();reject(new Error('Đã hủy tác vụ.'));},{once:true});});
  });
  try{
    const source=await image(), controller=new AbortController();
    const pending=send(f,source,[[10,10,12,10]],{signal:controller.signal});
    await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker did not start')),3000))]);
    const busy=await send(f,source,[[10,10,12,10]]);assert.equal(busy.status,429);
    controller.abort();await assert.rejects(pending,{name:'AbortError'});await stopped;
    let next;
    for(let i=0;i<30;i++) {
      next=await send(f,source,[[10,10,12,10]]);
      if(next.status!==429)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(next.status,200,await next.clone().text());
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')),[]);
  }finally{await f.close();}
});

test('shutdown cancels an unfinished multipart upload rather than waiting for the client',async()=>{
  const f=await fixture();
  const unfinished=http.request(f.base+'/api/watermark/remove',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=partial','Content-Length':'1000000'}});
  unfinished.on('error',()=>{});
  unfinished.write('--partial\r\n');
  try{
    const source=await image();
    assert.equal((await send(f,source,[[10,10,12,10]])).status,429);
    let timeout;
    try{
      await Promise.race([f.app.locals.watermark.close(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('shutdown is blocked by incomplete upload')),1000);})]);
    }finally{clearTimeout(timeout);}
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')).catch(()=>[]),[]);
  }finally{unfinished.destroy();await f.close();}
});

test('worker errors clean files and release the slot for a later successful removal',async()=>{
  let calls=0;
  const f=await fixture((config,request,options)=>{if(calls++===0)throw new Error('fixture worker error');return runWorker(config,request,options);});
  try{
    const source=await image();
    assert.equal((await send(f,source,[[10,10,12,10]])).status,500);
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')),[]);
    assert.equal((await send(f,source,[[10,10,12,10]])).status,200);
    assert.deepEqual(await fs.readdir(path.join(f.dir,'watermark')),[]);
  }finally{await f.close();}
});
