'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { scopedPath, directoryBytes } = require('../../shared/files');
const { normalizeImage } = require('../images/normalize');
const { jobDir, publicJob } = require('./pipeline');
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const coordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
// Bound synchronous raster loops across the whole request before source decode or file writes.
// One native 24MP polygon remains supported; long strokes must be split into smaller saves.
function validateRasterWork(operations,width,height) {
  const maximumWork=64_000_000;
  let work=0;
  const charge=amount=>{work+=amount;if(work>maximumWork)throw fail('Thao tác mask quá lớn. Hãy chia nét vẽ hoặc lưu từng nhóm nhỏ hơn.',413);};
  const bounds=(left,top,right,bottom)=>({
    columns:Math.max(0,Math.min(width-1,Math.ceil(right))-Math.max(0,Math.floor(left))+1),
    rows:Math.max(0,Math.min(height-1,Math.ceil(bottom))-Math.max(0,Math.floor(top))+1),
  });
  for(const op of operations) {
    const pts=op.points;
    if(op.kind==='brush') {
      for(let n=0;n<Math.max(1,pts.length-1);n++) {
        const a=pts[n],b=pts[n+1]||a,r=op.radius;
        const box=bounds(Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r);
        charge(box.columns*box.rows);
      }
    }else {
      const box=bounds(Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1])));
      // Each row scans every edge and sorts intersections; fill visits at most the clipped box.
      charge(box.rows*pts.length*(1+Math.ceil(Math.log2(pts.length)))+box.rows*box.columns);
    }
  }
}
function createLayerEditor({config,store}) {
  const locks=new Map();
  const readers=new Map(), pendingCleanup=new Set();
  async function withJob(id,fn) {
    const previous=locks.get(id)||Promise.resolve();
    const current=previous.catch(()=>{}).then(()=>fn(store.get(id)));
    locks.set(id,current);
    try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
  }
  function ready(job) {if(!job || !['done','partial'].includes(job.status))throw fail('Job chưa có kết quả để sửa.',409);}
  function find(job,id) {ready(job);const e=job.elements.find(e=>e.id===id);if(!e)throw fail('Không tìm thấy element.',404);return e;}
  function revision(e,value) {if(!Number.isSafeInteger(value)||value<0)throw fail('Revision không hợp lệ.');if(value!==(e.editRevision||0))throw fail('Element đã thay đổi. Hãy tải lại trước khi sửa.',409);}
  async function pruneEdits(job) {
    if (readers.has(job.id)) { pendingCleanup.add(job.id); return; }
    const output = path.join(jobDir(config,job.id),'elements');
    const retained = new Set(job.elements.flatMap(e => [
      e.file,e.mask,e.thumbnail,e.sourceFile,e.editSourceFile,e.initialFile,e.initialMask,e.initialThumbnail,
    ]));
    for (const entry of await fs.readdir(output,{withFileTypes:true})) {
      if (entry.isFile() && /^(region|text)_\d{3}\.edit-[0-9a-f-]{36}\.(image|mask|thumb|source)\.png$/.test(entry.name) && !retained.has(entry.name)) {
        await fs.unlink(path.join(output,entry.name));
      }
    }
  }
  function trackRead(id,res) {
    readers.set(id,(readers.get(id)||0)+1);
    res.once('close',()=>{
      const remaining=readers.get(id)-1;
      if (remaining) { readers.set(id,remaining); return; }
      readers.delete(id);
      if (pendingCleanup.delete(id)) void withJob(id,job=>job && pruneEdits(job)).catch(()=>{});
    });
  }
  async function transaction(job,work) {
    ready(job);
    const output=path.join(jobDir(config,job.id),'elements'), files=[];
    const write=async(name,data)=>{const target=scopedPath(output,name);files.push(target);await fs.writeFile(target,data);return name;};
    let result;
    try {
      result=await work(write,output);
      if(await directoryBytes(jobDir(config,job.id))>config.maxArtifactBytes)throw fail('Job vượt giới hạn dung lượng.',413);
      store.put(job);
    }catch(error){await Promise.all(files.map(file=>fs.unlink(file).catch(()=>{})));throw error;}
    await pruneEdits(job).catch(()=>{});
    return result;
  }
  const name=(e,suffix)=>`${e.id}.edit-${crypto.randomUUID()}.${suffix}.png`;
  async function initialize(job,e,write,output) {
    if(!e.editSourceFile) {
      let source;
      if(e.sourceFile)source=await fs.readFile(scopedPath(output,e.sourceFile));
      else {
        const [left,top,width,height]=e.bbox;
        if(![left,top,width,height].every(Number.isInteger)||width<1||height<1)throw fail('Kích thước crop không hợp lệ.');
        source=await sharp(path.join(jobDir(config,job.id),'source.png'),{limitInputPixels:config.maxPixels}).extract({left,top,width,height}).ensureAlpha().png().toBuffer();
      }
      const meta=await sharp(source,{limitInputPixels:config.maxPixels}).metadata();
      if(meta.width!==e.bbox[2]||meta.height!==e.bbox[3])throw fail('Ảnh nguồn không khớp kích thước layer.');
      e.editSourceFile=e.sourceFile || await write(name(e,'source'),source);
      e.initialFile=e.file;
      if(!e.mask) {
        const mask=await sharp(scopedPath(output,e.file),{limitInputPixels:config.maxPixels}).ensureAlpha().extractChannel('alpha').png().toBuffer();
        e.mask=await write(name(e,'mask'),mask);
      }
      e.initialMask=e.mask;
      e.initialThumbnail=e.thumbnail;
      e.initialSourcePixelsOnly=e.sourcePixelsOnly;
    }
  }
  async function getEdit(id,elementId) {return withJob(id,job=>transaction(job,async(write,output)=>{
    const e=find(job,elementId);await initialize(job,e,write,output);
    const element=publicJob(job).elements.find(item=>item.id===elementId), prefix=`/api/jobs/${id}/media/${elementId}`;
    const query=`?revision=${e.editRevision||0}`;
    return {element,width:e.bbox[2],height:e.bbox[3],sourceUrl:prefix+'-edit-source'+query,maskUrl:prefix+'-edit-mask'+query,previewUrl:element.url,revision:e.editRevision||0};
  }));}
  function validateOperations(operations,width,height) {
    if(!Array.isArray(operations)||!operations.length||operations.length>100)throw fail('Danh sách thao tác không hợp lệ.');
    let count=0;
    for(const op of operations) {
      if(!op||!['brush','polygon'].includes(op.kind)||!['add','erase'].includes(op.mode)||!Array.isArray(op.points)||op.points.length<(op.kind==='polygon'?3:1))throw fail('Thao tác mask không hợp lệ.');
      count+=op.points.length;if(count>10000)throw fail('Vượt giới hạn điểm mask.');
      if(op.kind==='brush'&&(!Number.isFinite(op.radius)||op.radius<1||op.radius>256))throw fail('Bán kính không hợp lệ.');
      if(op.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[1]<0||p[0]>width||p[1]>height))throw fail('Tọa độ mask không hợp lệ.');
    }
  }
  function paint(op,width,height,visit) {
    const pts=op.points,r=op.kind==='brush'?op.radius:0;
    const minX=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[0]))-r)),maxX=Math.min(width-1,Math.ceil(Math.max(...pts.map(p=>p[0]))+r));
    const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p[1]))-r)),maxY=Math.min(height-1,Math.ceil(Math.max(...pts.map(p=>p[1]))+r));
    if(op.kind==='brush') {
      // Rasterize each capsule separately to avoid points × crop-area work for a long stroke.
      for(let n=0;n<Math.max(1,pts.length-1);n++) {
        const a=pts[n],b=pts[n+1]||a,dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
        for(let y=Math.max(minY,Math.floor(Math.min(a[1],b[1])-r));y<=Math.min(maxY,Math.ceil(Math.max(a[1],b[1])+r));y++)for(let x=Math.max(minX,Math.floor(Math.min(a[0],b[0])-r));x<=Math.min(maxX,Math.ceil(Math.max(a[0],b[0])+r));x++) {
          const t=len?Math.max(0,Math.min(1,((x+.5-a[0])*dx+(y+.5-a[1])*dy)/len)):0;
          if((x+.5-a[0]-t*dx)**2+(y+.5-a[1]-t*dy)**2<=r*r)visit(y*width+x);
        }
      }
    } else {
      // Scanline intersection pairs fill polygon interiors at native pixel centers.
      for(let y=minY;y<=maxY;y++) {
        const intersections=[];
        for(let n=0,j=pts.length-1;n<pts.length;j=n++) {
          const a=pts[n],b=pts[j];if((a[1]>y+.5)!==(b[1]>y+.5))intersections.push(a[0]+(y+.5-a[1])*(b[0]-a[0])/(b[1]-a[1]));
        }
        intersections.sort((a,b)=>a-b);
        for(let n=0;n+1<intersections.length;n+=2)for(let x=Math.max(minX,Math.ceil(intersections[n]-.5));x<=Math.min(maxX,Math.ceil(intersections[n+1]-.5)-1);x++)visit(y*width+x);
      }
    }
  }
  async function mask(id,elementId,body) {return withJob(id,job=>transaction(job,async(write,output)=>{
    const e=find(job,elementId);revision(e,body.revision);const [,,width,height]=e.bbox;
    validateOperations(body.operations,width,height);validateRasterWork(body.operations,width,height);await initialize(job,e,write,output);
    const source=await sharp(scopedPath(output,e.editSourceFile),{limitInputPixels:config.maxPixels}).ensureAlpha().raw().toBuffer();
    const current=await sharp(scopedPath(output,e.file),{limitInputPixels:config.maxPixels}).ensureAlpha().raw().toBuffer();
    if(source.length!==width*height*4||current.length!==source.length)throw fail('Kích thước layer không hợp lệ.');
    for(const op of body.operations)paint(op,width,height,p=>{const i=p*4;current[i]=source[i];current[i+1]=source[i+1];current[i+2]=source[i+2];current[i+3]=op.mode==='add'?source[i+3]:0;});
    const alpha=Buffer.alloc(width*height);for(let p=0;p<alpha.length;p++){current[p*4+3]=Math.min(current[p*4+3],source[p*4+3]);alpha[p]=current[p*4+3];}
    const image=await sharp(current,{raw:{width,height,channels:4}}).png().toBuffer();
    e.file=await write(name(e,'image'),image);e.mask=await write(name(e,'mask'),await sharp(alpha,{raw:{width,height,channels:1}}).png().toBuffer());
    e.thumbnail=await write(name(e,'thumb'),await sharp(image).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).png().toBuffer());
    e.editRevision=(e.editRevision||0)+1;e.sourcePixelsOnly=e.sourcePixelsOnly!==false;
    return publicJob(job);
  }));}
  async function reset(id,elementId,body) {return withJob(id,job=>transaction(job,async(write,output)=>{
    const e=find(job,elementId);revision(e,body.revision);await initialize(job,e,write,output);
    e.file=e.initialFile;e.mask=e.initialMask;e.thumbnail=e.initialThumbnail;e.sourcePixelsOnly=e.initialSourcePixelsOnly;e.editRevision=(e.editRevision||0)+1;
    return publicJob(job);
  }));}
  async function importLayer(id,file,fields) {return withJob(id,async job=>{
    ready(job);if(job.elements.length>=Math.min(80,config.maxAssets))throw fail('Đã chạm giới hạn 80 layer.',409);
    if(!file)throw fail('Hãy chọn một ảnh.');
    const x=fields.x===undefined?0:Number(fields.x),y=fields.y===undefined?0:Number(fields.y),label=fields.label===undefined?'Original layer':fields.label;
    if(!coordinate(x)||!coordinate(y)||typeof label!=='string'||!label.trim()||label.length>100)throw fail('Nhãn hoặc tọa độ layer không hợp lệ.');
    const temp=path.join(jobDir(config,id),'.import-'+crypto.randomUUID());
    try {
      const normalized=await normalizeImage(file.buffer,temp,config,{preview:false});
      return await transaction(job,async(write)=>{
        const used=new Set(job.elements.map(e=>e.id));let n=1;while(used.has(`region_${String(n).padStart(3,'0')}`))n++;
        const e={id:`region_${String(n).padStart(3,'0')}`,bbox:[0,0,normalized.width,normalized.height],type:'region',outputKind:'mask',selected:true,label:label.trim(),placement:{x,y},layerVisible:true,layerOrder:job.elements.length,editRevision:0,sourcePixelsOnly:true,imported:true};
        const image=await fs.readFile(path.join(temp,'source.png'));
        e.file=await write(name(e,'image'),image);e.sourceFile=e.file;
        e.thumbnail=await write(name(e,'thumb'),await sharp(image).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).png().toBuffer());
        await initialize(job,e,write,path.join(jobDir(config,id),'elements'));job.elements.push(e);return publicJob(job);
      });
    }finally{await fs.rm(temp,{recursive:true,force:true});}
  });}
  async function placement(id,body) {return withJob(id,job=>{
    ready(job);if(!Array.isArray(body.layers)||!body.layers.length||body.layers.length>80)throw fail('Danh sách layer không hợp lệ.');
    const seen=new Set();for(const layer of body.layers){if(!layer||seen.has(layer.id)||!job.elements.some(e=>e.id===layer.id)||!coordinate(layer.x)||!coordinate(layer.y)||typeof layer.visible!=='boolean'||!Number.isSafeInteger(layer.order)||Math.abs(layer.order)>1_000_000)throw fail('Vị trí layer không hợp lệ.');seen.add(layer.id);}
    for(const layer of body.layers){const e=job.elements.find(e=>e.id===layer.id);e.placement={x:layer.x,y:layer.y};e.layerVisible=layer.visible;e.layerOrder=layer.order;}
    store.put(job);return publicJob(job);
  });}
  return {withJob,trackRead,hasReaders:id=>readers.has(id),getEdit,mask,reset,importLayer,placement};
}
module.exports={createLayerEditor,validateRasterWork};
