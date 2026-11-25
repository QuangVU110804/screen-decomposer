'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { createApp } = require('../../src/app');
const { createConfig } = require('../../src/config');
async function fixture(overrides={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'layer-edit-'));
  const config={...createConfig({dataDir:dir}),...overrides};
  const app=createApp({config,status:async()=>({ready:true})});
  const id=crypto.randomUUID(), output=path.join(dir,'jobs',id,'elements');
  await fs.mkdir(output,{recursive:true});
  // Original alpha is translucent at (2,2); all RGB is deliberately distinct from extracted RGB.
  const pixels=Buffer.alloc(6*6*4);for(let p=0;p<36;p++){pixels.set([31+p,71,113,p===14?93:255],p*4);}
  const original=await sharp(pixels,{raw:{width:6,height:6,channels:4}}).png().toBuffer();
  await fs.writeFile(path.join(dir,'jobs',id,'source.png'),original);
  await fs.writeFile(path.join(dir,'jobs',id,'preview.webp'),original);
  const cut=Buffer.from(pixels);for(let p=0;p<36;p++){cut[p*4]=201;cut[p*4+3]=(p===0?255:0);}
  await sharp(cut,{raw:{width:6,height:6,channels:4}}).png().toFile(path.join(output,'region_001.png'));
  const element={id:'region_001',file:'region_001.png',thumbnail:'region_001.png',bbox:[0,0,6,6],selected:true,sourcePixelsOnly:false};
  app.locals.store.put({id,status:'done',source:{width:6,height:6},elements:[element,{...element,id:'region_002',file:'region_001.png'}]});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`, job=`/api/jobs/${id}`;
  async function request(route,body,method='POST'){return fetch(base+job+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
  async function raw(url){const res=await fetch(base+url);assert.equal(res.status,200);return sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer();}
  return {app,dir,output,id,base,job,pixels,cut,request,raw,close:async()=>{await app.locals.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}};
}
const brush={kind:'brush',mode:'add',radius:1,points:[[2.5,2.5]]};
test('native mask restore retains source RGB/alpha and independent overlapping layers; reset restores initial extraction',async()=>{
 const f=await fixture();try{
  let response=await fetch(f.base+f.job+'/elements/region_001/edit');assert.equal(response.status,200);const edit=await response.json();
  assert.equal(edit.width,6);assert.equal(edit.revision,0);assert.deepEqual(await f.raw(edit.sourceUrl),f.pixels);
  response=await f.request('/elements/region_001/mask',{revision:0,operations:[brush]});assert.equal(response.status,200,await response.clone().text());
  const job=await response.json(), layer=job.elements[0], raw=await f.raw(layer.url);
  const saved=f.app.locals.store.get(f.id).elements[0];
  assert.deepEqual([...raw.subarray(14*4,15*4)],[45,71,113,93]);
  assert.deepEqual([...raw.subarray(0,4)],[201,71,113,255]); // corrected pixel outside stroke survives
  assert.deepEqual(await f.raw(job.elements[1].url),f.cut);assert.equal(layer.editRevision,1);assert.match(layer.url,/revision=1/);
  const stale=await f.request('/elements/region_001/mask',{revision:0,operations:[brush]});assert.equal(stale.status,409);
  const reset=await f.request('/elements/region_001/reset-mask',{revision:1});assert.equal(reset.status,200);
  assert.deepEqual(await f.raw((await reset.json()).elements[0].url),f.cut);
  for (const obsolete of [saved.file,saved.mask,saved.thumbnail]) await assert.rejects(fs.stat(path.join(f.output,obsolete)),{code:'ENOENT'});
  for (const retained of [saved.initialFile,saved.initialMask,saved.editSourceFile]) assert.ok((await fs.stat(path.join(f.output,retained))).size);
 }finally{await f.close();}
});
test('superseded mask files survive an active download and are removed when it closes',async()=>{
 const f=await fixture();
 try{
  const {createLayerEditor}=require('../../src/features/elements/editing');
  const store=f.app.locals.store;
  const editor=createLayerEditor({config:createConfig({dataDir:f.dir}),store});
  await editor.mask(f.id,'region_001',{revision:0,operations:[brush]});
  const previous=store.get(f.id).elements[0];
  const download=new EventEmitter();
  editor.trackRead(f.id,download);
  await editor.reset(f.id,'region_001',{revision:1});
  assert.ok((await fs.stat(path.join(f.output,previous.file))).size);
  download.emit('close');
  await editor.withJob(f.id,()=>{});
  await assert.rejects(fs.stat(path.join(f.output,previous.file)),{code:'ENOENT'});
  assert.ok((await fs.stat(path.join(f.output,previous.initialFile))).size);
 }finally{await f.close();}
});
test('import keeps RGBA/native dimensions and layer placement does not resample; reject malformed mutation',async()=>{
 const f=await fixture();try{
  const pixels=Buffer.from([9,81,145,0,18,97,199,101]);const png=await sharp(pixels,{raw:{width:2,height:1,channels:4}}).png().toBuffer();
  const form=new FormData();form.append('file',new Blob([png]),'original.png');form.append('label','Original B');form.append('x','-12');form.append('y','7.5');
  const response=await fetch(f.base+f.job+'/layers',{method:'POST',body:form});assert.equal(response.status,200,await response.clone().text());
  const job=await response.json(), imported=job.elements.at(-1);assert.deepEqual(imported.bbox,[0,0,2,1]);assert.deepEqual(imported.placement,{x:-12,y:7.5});assert.deepEqual(await f.raw(imported.url),pixels);
  const placed=await f.request('/layers',{layers:[{id:imported.id,x:99,y:-10,visible:false,order:0}]},'PATCH');assert.equal(placed.status,200);const updated=(await placed.json()).elements.at(-1);assert.equal(updated.layerVisible,false);assert.deepEqual(await f.raw(updated.url),pixels);
  for(const body of [{revision:0,operations:[{...brush,radius:0}]},{revision:0,operations:[{kind:'polygon',mode:'add',points:[[0,0],[1,1]]}]},{revision:0,operations:[{...brush,points:[[999,2]]}]}])assert.equal((await f.request('/elements/region_001/mask',body)).status,400);
  assert.equal((await f.request('/layers',{layers:[{id:'../bad',x:0,y:0,visible:true,order:0}]},'PATCH')).status,400);
  const bad=new FormData();bad.append('file',new Blob(['bad']),'bad.png');assert.equal((await fetch(f.base+f.job+'/layers',{method:'POST',body:bad})).status,400);
 }finally{await f.close();}
});
test('concurrent edits serialize, placement changes survive; budget failure leaves current generation intact',async()=>{
 const f=await fixture();try{
  const results=await Promise.all([f.request('/elements/region_001/mask',{revision:0,operations:[brush]}),f.request('/elements/region_001/mask',{revision:0,operations:[brush]}),f.request('/layers',{layers:[{id:'region_002',x:2,y:3,visible:false,order:9}]},'PATCH')]);
  assert.deepEqual(results.slice(0,2).map(r=>r.status).sort(),[200,409]);assert.equal(results[2].status,200);
  const job=await (await fetch(f.base+f.job)).json();assert.equal(job.elements[0].editRevision,1);assert.deepEqual(job.elements[1].placement,{x:2,y:3});
 }finally{await f.close();}
 const low=await fixture({maxArtifactBytes:1});try{
  const result=await low.request('/elements/region_001/mask',{revision:0,operations:[brush]});assert.equal(result.status,413);
  const stored=low.app.locals.store.get(low.id);assert.equal(stored.elements[0].editRevision,undefined);assert.equal(stored.elements[0].file,'region_001.png');
  assert.deepEqual((await fs.readdir(low.output)).sort(),['region_001.png']);
 }finally{await low.close();}
});
test('polygon and interpolated brush geometry edit native pixels without blurring; invalid batches are atomic',async()=>{
 const f=await fixture();try{
  let response=await f.request('/elements/region_001/mask',{revision:0,operations:[{kind:'polygon',mode:'add',points:[[1,1],[4,1],[4,4],[1,4]]}]});assert.equal(response.status,200);
  let job=await response.json(),raw=await f.raw(job.elements[0].url);assert.equal(raw[(1*6+1)*4+3],255);assert.equal(raw[(4*6+4)*4+3],0);assert.equal(raw[(2*6+2)*4+3],93);
  response=await f.request('/elements/region_001/mask',{revision:1,operations:[{kind:'brush',mode:'erase',radius:1,points:[[1.5,2.5],[3.5,2.5]]}]});assert.equal(response.status,200);job=await response.json();raw=await f.raw(job.elements[0].url);assert.equal(raw[(2*6+2)*4+3],0);assert.equal(raw[(1*6+2)*4+3],0);assert.equal(raw[(3*6+2)*4+3],0);assert.equal(raw[(1*6+1)*4+3],0);assert.equal(raw[(3*6+3)*4+3],0);
  const invalid=await f.request('/elements/region_001/mask',{revision:2,operations:[brush,{...brush,mode:'invalid'}]});assert.equal(invalid.status,400);assert.equal(f.app.locals.store.get(f.id).elements[0].editRevision,2);
  for(const body of [null,{}, {layers:[{id:'region_001',x:0,y:0,visible:true,order:0},{id:'region_001',x:1,y:1,visible:true,order:1}]}])assert.equal((await f.request('/layers',body,'PATCH')).status,400);
 }finally{await f.close();}
});
test('layer import cap is checked inside the lock and public/media never expose internal artifact names',async()=>{
 const f=await fixture();try{
  const job=f.app.locals.store.get(f.id);job.elements=Array.from({length:79},(_,i)=>({...job.elements[0],id:`region_${String(i+1).padStart(3,'0')}`}));f.app.locals.store.put(job);
  const png=await sharp({create:{width:2,height:2,channels:4,background:'blue'}}).png().toBuffer();
  function form(){const form=new FormData();form.append('file',new Blob([png]),'B.png');return form;}
  const imports=await Promise.all([fetch(f.base+f.job+'/layers',{method:'POST',body:form()}),fetch(f.base+f.job+'/layers',{method:'POST',body:form()})]);assert.deepEqual(imports.map(r=>r.status).sort(),[200,409]);assert.equal(f.app.locals.store.get(f.id).elements.length,80);
  const edit=await (await fetch(f.base+f.job+'/elements/region_001/edit')).json();assert.equal(JSON.stringify(edit).includes('.edit-'),false);assert.equal(JSON.stringify(edit).includes('initialFile'),false);assert.equal(JSON.stringify(edit).includes('sourceFile'),false);
  assert.equal((await fetch(f.base+f.job+'/media/region_001.source.png')).status,404);
 }finally{await f.close();}
});
test('optional original source crop survives pipeline cache and artifact trimming; unsafe source paths fail',async()=>{
 const {createPipeline}=require('../../src/features/elements/pipeline');
 for(const trimming of [false,true]) {
  const f=await fixture(trimming?{maxArtifactBytes:5000}:{});try{
   const config={...createConfig({dataDir:f.dir}),...(trimming?{maxArtifactBytes:5000}:{})};let calls=0;
   const worker=async()=>{calls++;await fs.writeFile(path.join(f.output,'region_003.png'),await sharp(f.cut,{raw:{width:6,height:6,channels:4}}).png().toBuffer());await fs.copyFile(path.join(f.dir,'jobs',f.id,'source.png'),path.join(f.output,'region_003.source.png'));if(trimming)await fs.writeFile(path.join(f.output,'orphan.tmp'),Buffer.alloc(20000));return {elements:[{id:'region_003',file:'region_003.png',thumbnail:'region_003.png',sourceFile:'region_003.source.png',bbox:[0,0,6,6]}],warnings:[],engines:{segmentation:{ok:true}}};};
   const run=createPipeline({config,store:f.app.locals.store,worker});await run(f.id,new AbortController().signal);
   let job=f.app.locals.store.get(f.id);assert.ok(['done','partial'].includes(job.status),JSON.stringify(job));assert.equal(job.elements[0].sourceFile,'region_003.source.png');assert.deepEqual(await sharp(path.join(f.output,'region_003.source.png')).raw().toBuffer(),f.pixels);
   if(!trimming){await fs.unlink(path.join(f.output,'region_003.source.png'));await run(f.id,new AbortController().signal);job=f.app.locals.store.get(f.id);assert.equal(job.cacheHit,true);assert.equal(calls,1);assert.deepEqual(await sharp(path.join(f.output,'region_003.source.png')).raw().toBuffer(),f.pixels);}
   else {await assert.rejects(fs.stat(path.join(f.output,'orphan.tmp')),/ENOENT/);}
  }finally{await f.close();}
 }
 const {validateElements}=require('../../src/features/elements/pipeline');const f=await fixture();try{await assert.rejects(validateElements([{id:'region_001',file:'region_001.png',sourceFile:'../source.png',bbox:[0,0,6,6]}],f.output,80),/file/);}finally{await f.close();}
});
test('editor enforces upload/pixel/operation/point limits without adding a layer',async()=>{
 for(const overrides of [{maxBytes:100},{maxPixels:4}]){
  const f=await fixture(overrides);try{
   const png=await sharp({create:{width:3,height:2,channels:4,background:'red'}}).png().toBuffer();const form=new FormData();form.append('file',new Blob([overrides.maxBytes?Buffer.alloc(101):png]),'B.png');
   const res=await fetch(f.base+f.job+'/layers',{method:'POST',body:form});assert.ok([400,413].includes(res.status));assert.equal(f.app.locals.store.get(f.id).elements.length,2);
  }finally{await f.close();}
 }
 const f=await fixture();try{
  for(const operations of [Array.from({length:101},()=>brush),[{...brush,points:Array.from({length:10001},()=>[2,2])}]])assert.equal((await f.request('/elements/region_001/mask',{revision:0,operations})).status,400);
  const res=await f.request('/elements/region_001/mask',{revision:0,operations:[brush],padding:'a'.repeat(1024*1024)});assert.equal(res.status,413);assert.equal(f.app.locals.store.get(f.id).elements[0].editRevision,undefined);
 }finally{await f.close();}
});
test('raster work guard rejects long native zigzags before source decoding or generation writes',async()=>{
 const f=await fixture();try{
  const job=f.app.locals.store.get(f.id);job.elements[0].bbox=[0,0,6000,4000];f.app.locals.store.put(job);
  for(const operations of [[{...brush,points:Array.from({length:200},(_,i)=>i%2?[6000,4000]:[0,0])}],Array.from({length:3},()=>({...brush,points:[[0,0],[6000,4000]]}))]){
   const response=await f.request('/elements/region_001/mask',{revision:0,operations});assert.equal(response.status,413,await response.clone().text());
   assert.match((await response.json()).error,/nhỏ hơn/);assert.equal(f.app.locals.store.get(f.id).elements[0].editRevision,undefined);assert.deepEqual(await fs.readdir(f.output),['region_001.png']);
  }
 }finally{await f.close();}
});
test('raster work guard allows a native 24MP polygon and ordinary brush but bounds costly polygon scans',()=>{
 const {validateRasterWork}=require('../../src/features/elements/editing');
 assert.doesNotThrow(()=>validateRasterWork([{kind:'polygon',points:[[0,0],[6000,0],[6000,4000],[0,4000]]}],6000,4000));
 assert.doesNotThrow(()=>validateRasterWork([{...brush,radius:40,points:[[100,100],[200,200],[250,200]]}],6000,4000));
 assert.throws(()=>validateRasterWork([{kind:'polygon',points:Array.from({length:10000},(_,i)=>i%2?[6000,4000]:[0,0])}],6000,4000),{status:413});
});
