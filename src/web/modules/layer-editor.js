import {json,post,patch,request} from './api.js';
import {layerPoint,orderedLayers,MaskHistory,initialLayerId} from './layer-state.mjs';

const $=id=>document.getElementById(id);
const id=new URLSearchParams(location.search).get('job');
const drafts=new Map(),bitmaps=new Map();
let job,selectedId,solo=false,layoutDirty=false,saving=false,loadingToken=0,frame=0,pointer=null,underlay;
const canvas=$('layerCanvas'),ctx=canvas.getContext('2d');
const scene=()=>({width:job?.source.width||1,height:job?.source.height||1});
const selected=()=>job?.elements.find(e=>e.id===selectedId);
const draft=()=>drafts.get(selectedId);
const dirty=()=>layoutDirty||[...drafts.values()].some(d=>d.history.canUndo||d.polygon?.length);
const base=()=>`/api/jobs/${encodeURIComponent(id)}`;
function error(message=''){$('editorError').textContent=message;$('editorError').hidden=!message;}
function status(message){$('editorStatus').textContent=message;}
function makeCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
async function bitmap(url,maxEdge=1024){
  const response=await request(url);const blob=await response.blob();
  const full=await createImageBitmap(blob);
  if(Math.max(full.width,full.height)<=maxEdge)return full;
  const scale=maxEdge/Math.max(full.width,full.height);
  const small=await createImageBitmap(full,{resizeWidth:Math.max(1,Math.round(full.width*scale)),resizeHeight:Math.max(1,Math.round(full.height*scale)),resizeQuality:'high'});
  full.close();return small;
}
function invalidateBitmap(elementId){const entry=bitmaps.get(elementId);if(entry?.image)entry.image.close();bitmaps.delete(elementId);}
function loadBitmap(e){
  const key=e.url;
  if(bitmaps.get(e.id)?.key===key)return;
  invalidateBitmap(e.id);
  const entry={key};bitmaps.set(e.id,entry);
  bitmap(e.url,768).then(image=>{if(bitmaps.get(e.id)!==entry){image.close();return;}entry.image=image;redraw();}).catch(e=>{entry.failed=true;error(e.message);});
}
function adoptJob(next,preserveLayout=true){
  if(job&&layoutDirty&&preserveLayout){const old=new Map(job.elements.map(e=>[e.id,e]));for(const e of next.elements){const previous=old.get(e.id);if(previous){e.placement=previous.placement;e.layerVisible=previous.layerVisible;e.layerOrder=previous.layerOrder;}}}
  job=next;
  for(const [index,e] of job.elements.entries()){
    e.placement??={x:e.bbox[0],y:e.bbox[1]};e.layerVisible??=true;e.layerOrder??=index;loadBitmap(e);
  }
  $('layerCount').textContent=job.elements.length;
  $('editorName').textContent=`${job.name} · ${job.source.width} × ${job.source.height} px`;
  $('canvasInfo').textContent='Xem trước có thể thu nhỏ · PNG từng layer xuất ở pixel gốc';
  renderList();sizeCanvas();
}
function renderList(){
  const fragment=document.createDocumentFragment();
  const layers=orderedLayers(job?.elements||[]).reverse();
  for(const [index,e] of layers.entries()){
    const row=document.createElement('div');row.className='layer-row';row.classList.toggle('selected',e.id===selectedId);
    const button=document.createElement('button');button.type='button';button.className='layer-choice';button.setAttribute('aria-pressed',String(e.id===selectedId));
    const img=document.createElement('img');img.src=e.thumbnailUrl;img.alt='';img.loading='lazy';
    const name=document.createElement('span');name.textContent=e.label;button.append(img,name);button.addEventListener('click',()=>select(e.id));row.append(button);
    const controls=document.createElement('div');controls.className='layer-row-controls';
    for(const [label,checked,callback] of [
      ['Hiện',e.layerVisible,value=>{e.layerVisible=value;layoutDirty=true;syncInspector();redraw();}],
      ['Tải',e.selected!==false,async value=>{const old=e.selected;e.selected=value;try{await patch(`${base()}/elements/${e.id}`,{selected:value});}catch(err){e.selected=old;error(err.message);renderList();}}]
    ]){
      const l=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.checked=checked;input.setAttribute('aria-label',`${label} ${e.label}`);input.addEventListener('change',()=>callback(input.checked));l.append(input,document.createTextNode(label));controls.append(l);
    }
    for(const [text,direction,disabled] of [['↑',1,index===0],['↓',-1,index===layers.length-1]]){
      const b=document.createElement('button');b.type='button';b.textContent=text;b.disabled=disabled;b.dataset.unavailable=String(disabled);b.setAttribute('aria-label',`${direction>0?'Đưa lên':'Đưa xuống'} ${e.label}`);b.addEventListener('click',()=>moveLayer(e.id,direction));controls.append(b);
    }
    row.append(controls);fragment.append(row);
  }
  $('layerList').replaceChildren(fragment);
}
function moveLayer(elementId,direction){
  const layers=orderedLayers(job.elements),index=layers.findIndex(e=>e.id===elementId),other=index+direction;
  if(other<0||other>=layers.length)return;
  [layers[index],layers[other]]=[layers[other],layers[index]];
  layers.forEach((e,i)=>e.layerOrder=i);layoutDirty=true;renderList();syncInspector();redraw();
}
function syncInspector(){
  const e=selected(),d=draft();
  $('selectedName').textContent=e?.label||'Chọn layer';
  $('layerMeta').textContent=e?`${e.bbox[2]} × ${e.bbox[3]} pixel gốc · bản ${d?.edit?.revision??e.editRevision??0}`:'';
  $('layerWarning').textContent=e?.edgeWarning||'Kiểm tra mask trên nền sáng và tối.';
  $('layerX').value=e?.placement.x??0;$('layerY').value=e?.placement.y??0;
  $('downloadLayer').href=e?.url||'#';$('downloadLayer').download=(e?.id||'layer')+'.png';
  $('downloadOriginal').href=d?.edit?.sourceUrl||'#';$('downloadOriginal').hidden=!d?.ready;
  $('undoMask').disabled=saving||!d?.history.canUndo;$('redoMask').disabled=saving||!d?.history.canRedo;
  $('saveMask').disabled=saving||!d?.ready||!d.history.canUndo||Boolean(d.polygon?.length);
  $('discardMask').disabled=saving||!d||(!d.history.canUndo&&!d.polygon?.length);
  $('resetMask').disabled=saving||!d?.ready;
  $('maskTool').disabled=saving||!d?.ready;$('importLayer').disabled=saving;
  for(const control of $('layerList').querySelectorAll('input,button'))control.disabled=saving||control.dataset.unavailable==='true';
  for(const key of ['layerX','layerY','polygonPoints','brushRadius','allVisible','soloLayer','applyPolygon','clearPolygon'])$(key).disabled=saving;
  $('exportLayers').disabled=saving||!job;
  $('saveLayout').disabled=saving||!layoutDirty;
  $('polygonControls').hidden=!$('maskTool').value.startsWith('polygon');
  $('polygonPoints').value=(d?.polygon||[]).map(p=>p.join(',')).join('; ');
  $('soloLayer').setAttribute('aria-pressed',String(solo));$('soloLayer').textContent=solo?'Thoát xem riêng':'Xem riêng';
}
function releaseDraft(elementId){const d=drafts.get(elementId);if(d){d.original?.close();d.source?.close();drafts.delete(elementId);}}
async function select(elementId){
  selectedId=elementId;renderList();error();const token=++loadingToken;
  if(!drafts.has(elementId)){
    const d={history:new MaskHistory(),polygon:[],ready:false};drafts.set(elementId,d);
    d.loading=(async()=>{
      const edit=await json(`${base()}/elements/${elementId}/edit`);
      const [original,source]=await Promise.all([bitmap(edit.previewUrl,2048),bitmap(edit.sourceUrl,2048)]);
      Object.assign(d,{edit,original,source,ready:true});d.work=makeCanvas(original.width,original.height);rebuild(d,job.elements.find(e=>e.id===elementId));
    })();
  }
  const d=drafts.get(elementId);
  if(!d.ready){
    status('Đang mở pixel nguồn của layer…');syncInspector();
    try{await d.loading;}
    catch(e){if(drafts.get(elementId)===d)releaseDraft(elementId);if(token===loadingToken){error(e.message);status('Chưa mở được layer.');syncInspector();}return;}
  }
  if(token===loadingToken){syncInspector();redraw();status('Sẵn sàng · chọn cọ hoặc đa giác để sửa mask.');}
}
function pathOperation(context,op,sx,sy){
  context.beginPath();
  if(op.kind==='polygon'){
    op.points.forEach((p,i)=>i?context.lineTo(p[0]*sx,p[1]*sy):context.moveTo(p[0]*sx,p[1]*sy));context.closePath();context.fill();
  }else if(op.points.length===1){context.arc(op.points[0][0]*sx,op.points[0][1]*sy,op.radius*sx,0,Math.PI*2);context.fill();}
  else{context.lineWidth=op.radius*2*sx;context.lineCap='round';context.lineJoin='round';op.points.forEach((p,i)=>i?context.lineTo(p[0]*sx,p[1]*sy):context.moveTo(p[0]*sx,p[1]*sy));context.stroke();}
}
function rebuild(d=draft(),e=selected()){
  if(!d?.ready||!e)return;
  const w=d.work.width,h=d.work.height,c=d.work.getContext('2d');
  c.clearRect(0,0,w,h);c.drawImage(d.original,0,0,w,h);
  const opMask=makeCanvas(w,h),m=opMask.getContext('2d');
  const sourcePatch=makeCanvas(w,h),s=sourcePatch.getContext('2d');
  const operations=d.history.operations;
  if(pointer?.operation&&selectedId===e.id)operations.push(pointer.operation);
  for(const op of operations){
    m.clearRect(0,0,w,h);m.fillStyle=m.strokeStyle='#fff';pathOperation(m,op,w/e.bbox[2],h/e.bbox[3]);
    c.globalCompositeOperation='destination-out';c.drawImage(opMask,0,0);c.globalCompositeOperation='source-over';
    if(op.mode==='add'){
      s.clearRect(0,0,w,h);s.drawImage(d.source,0,0,w,h);s.globalCompositeOperation='destination-in';s.drawImage(opMask,0,0);s.globalCompositeOperation='source-over';c.drawImage(sourcePatch,0,0);
    }
  }
  redraw();
}
function sizeCanvas(){
  if(!job)return;
  const {width,height}=scene();const ratio=Math.min(1,4096/Math.max(width,height));
  const w=Math.max(1,Math.round(width*ratio)),h=Math.max(1,Math.round(height*ratio));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const zoom=$('zoom').value==='fit'?Math.min(1,Math.max(100,$('canvasArea').clientWidth-2)/width):Number($('zoom').value);
  canvas.style.width=`${width*zoom}px`;canvas.style.height=`${height*zoom}px`;redraw();
}
function redraw(){if(!frame)frame=requestAnimationFrame(draw);}
function draw(){
  frame=0;if(!job)return;
  const {width,height}=scene(),sx=canvas.width/width,sy=canvas.height/height;
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=$('zoom').value==='fit';
  if($('sourceUnderlay').checked&&underlay&&!solo){ctx.globalAlpha=.65;ctx.drawImage(underlay,0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}
  for(const e of orderedLayers(job.elements)){
    if((solo&&e.id!==selectedId)||(!solo&&!e.layerVisible))continue;
    const layerDraft=drafts.get(e.id);
    const image=layerDraft?.ready?layerDraft.work:bitmaps.get(e.id)?.image;
    if(image)ctx.drawImage(image,e.placement.x*sx,e.placement.y*sy,e.bbox[2]*sx,e.bbox[3]*sy);
  }
  const e=selected(),d=draft();
  if(e&&(e.layerVisible||solo)){
    ctx.save();ctx.strokeStyle='#c6b5ff';ctx.lineWidth=Math.max(1,sx);ctx.setLineDash([5,4]);ctx.strokeRect(e.placement.x*sx,e.placement.y*sy,e.bbox[2]*sx,e.bbox[3]*sy);ctx.restore();
    if(d?.polygon.length){ctx.save();ctx.strokeStyle='#ffdd83';ctx.lineWidth=2;ctx.beginPath();d.polygon.forEach((p,i)=>i?ctx.lineTo((p[0]+e.placement.x)*sx,(p[1]+e.placement.y)*sy):ctx.moveTo((p[0]+e.placement.x)*sx,(p[1]+e.placement.y)*sy));ctx.stroke();for(const p of d.polygon){ctx.beginPath();ctx.arc((p[0]+e.placement.x)*sx,(p[1]+e.placement.y)*sy,3,0,Math.PI*2);ctx.fillStyle='#ffdd83';ctx.fill();}ctx.restore();}
  }
}
function getPoint(event){const e=selected();return e?layerPoint(event.clientX,event.clientY,canvas.getBoundingClientRect(),scene(),e):null;}
canvas.addEventListener('pointerdown',event=>{
  if(saving||event.button!==0)return;
  const tool=$('maskTool').value;
  if(tool==='view'){pointer={pan:true,x:event.clientX,y:event.clientY,left:$('canvasArea').scrollLeft,top:$('canvasArea').scrollTop};canvas.setPointerCapture(event.pointerId);return;}
  const point=getPoint(event),d=draft();if(!point||!d?.ready)return;
  event.preventDefault();canvas.setPointerCapture(event.pointerId);
  if(tool.startsWith('polygon')){d.polygon.push(point);syncInspector();redraw();return;}
  pointer={operation:{kind:'brush',mode:tool,radius:Number($('brushRadius').value),points:[point]}};rebuild();
});
canvas.addEventListener('pointermove',event=>{
  if(!pointer)return;
  if(pointer.pan){$('canvasArea').scrollLeft=pointer.left-(event.clientX-pointer.x);$('canvasArea').scrollTop=pointer.top-(event.clientY-pointer.y);return;}
  const point=getPoint(event),points=pointer.operation.points;if(!point)return;
  const last=points.at(-1);if(Math.hypot(point[0]-last[0],point[1]-last[1])<.5)return;
  if(points.length>=2000)return;
  points.push(point);rebuild();
});
function finishPointer(cancel=false){
  if(!pointer)return;const pending=pointer;pointer=null;
  if(pending.operation&&!cancel){try{draft().history.push(pending.operation);status('Mask đã sửa trong bản xem trước · bấm Lưu mask.');}catch(e){error(e.message);}}
  rebuild();syncInspector();
}
canvas.addEventListener('pointerup',()=>finishPointer());canvas.addEventListener('pointercancel',()=>finishPointer(true));
$('maskTool').addEventListener('change',()=>{$('canvasArea').classList.toggle('drawing',$('maskTool').value!=='view');syncInspector();});
$('brushRadius').addEventListener('input',()=>$('radiusValue').textContent=$('brushRadius').value);
$('undoMask').addEventListener('click',()=>{draft()?.history.undo();rebuild();syncInspector();});
$('redoMask').addEventListener('click',()=>{draft()?.history.redo();rebuild();syncInspector();});
function clearPolygon(){if(draft())draft().polygon=[];syncInspector();redraw();}
$('clearPolygon').addEventListener('click',clearPolygon);
$('applyPolygon').addEventListener('click',()=>{
  try{
    const e=selected(),d=draft();if(!d?.ready)return;
    const points=$('polygonPoints').value.split(';').map(v=>v.trim()).filter(Boolean).map(v=>v.split(',').map(Number));
    if(points.length<3||points.some(p=>p.length!==2||p.some(n=>!Number.isFinite(n))||p[0]<0||p[1]<0||p[0]>e.bbox[2]||p[1]>e.bbox[3]))throw new Error('Nhập ít nhất 3 điểm x,y trong phạm vi crop của layer.');
    d.history.push({kind:'polygon',mode:$('maskTool').value.endsWith('add')?'add':'erase',points});d.polygon=[];rebuild();syncInspector();error();
  }catch(e){error(e.message);}
});
$('discardMask').addEventListener('click',()=>{draft()?.history.clear();clearPolygon();rebuild();status('Đã bỏ sửa chưa lưu.');});
async function saveMask(reset=false){
  const e=selected(),d=draft();if(!e||!d?.ready||saving)return;
  saving=true;syncInspector();error();
  try{
    const next=await post(`${base()}/elements/${e.id}/${reset?'reset-mask':'mask'}`,{revision:d.edit.revision,...(!reset?{operations:d.history.operations}:{})});
    releaseDraft(e.id);invalidateBitmap(e.id);adoptJob(next);await select(e.id);status(reset?'Đã khôi phục bản tách ban đầu.':'Đã lưu mask ở kích thước gốc; các layer khác giữ nguyên.');
  }catch(err){error(err.message+' Bản sửa chưa lưu vẫn được giữ trong phiên này.');}
  finally{saving=false;syncInspector();}
}
$('saveMask').addEventListener('click',()=>saveMask());$('resetMask').addEventListener('click',()=>saveMask(true));
for(const key of ['X','Y'])$(`layer${key}`).addEventListener('change',()=>{
  const e=selected(),value=Number($(`layer${key}`).value);if(!e)return;
  if(!Number.isFinite(value)||Math.abs(value)>100000){error('Vị trí phải nằm trong khoảng −100000 đến 100000.');syncInspector();return;}
  e.placement[key.toLowerCase()]=Math.round(value);layoutDirty=true;syncInspector();redraw();
});
$('saveLayout').addEventListener('click',async()=>{
  if(!job||saving)return;saving=true;syncInspector();error();
  try{const next=await patch(`${base()}/layers`,{layers:orderedLayers(job.elements).map((e,i)=>({id:e.id,x:e.placement.x,y:e.placement.y,visible:e.layerVisible,order:i}))});layoutDirty=false;adoptJob(next,false);status('Đã lưu vị trí, thứ tự và trạng thái hiển thị.');}
  catch(e){error(e.message);}finally{saving=false;syncInspector();}
});
$('allVisible').addEventListener('click',()=>{for(const e of job?.elements||[])e.layerVisible=true;solo=false;layoutDirty=true;renderList();syncInspector();redraw();});
$('soloLayer').addEventListener('click',()=>{solo=!solo;syncInspector();redraw();});
$('zoom').addEventListener('change',sizeCanvas);new ResizeObserver(sizeCanvas).observe($('canvasArea'));
$('canvasBackground').addEventListener('change',()=>{$('canvasArea').className=`canvas-area ${$('canvasBackground').value}`;redraw();});
$('sourceUnderlay').addEventListener('change',redraw);
$('importLayer').addEventListener('click',()=>$('originalFile').click());
$('originalFile').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file||saving)return;
  if(file.size>20*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){error('Chọn JPG/PNG/WebP tĩnh tối đa 20 MB.');return;}
  saving=true;syncInspector();error();status('Đang nhập ảnh gốc, giữ nguyên pixel…');
  try{
    const body=new FormData();body.append('file',file);body.append('label',file.name);body.append('x','0');body.append('y','0');
    const old=new Set(job.elements.map(e=>e.id));const next=await json(`${base()}/layers`,{method:'POST',body});adoptJob(next);
    const added=next.elements.find(e=>!old.has(e.id));if(added)await select(added.id);status('Đã nhập ảnh gốc. Chỉnh vị trí hoặc mask để lấy toàn bộ vật thể B.');
  }catch(e){error(e.message);}finally{saving=false;event.target.value='';syncInspector();}
});
$('exportLayers').addEventListener('click',async()=>{
  if(!job||saving)return;
  if(dirty()){error('Lưu hoặc bỏ các chỉnh sửa mask và lưu vị trí trước khi tải ZIP.');return;}
  const ids=job.elements.filter(e=>e.selected!==false).map(e=>e.id);if(!ids.length){error('Chọn ít nhất một ô Tải trong danh sách layer.');return;}
  saving=true;syncInspector();error();
  try{const response=await request(`${base()}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=`layers-${id.slice(0,8)}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);status('ZIP gồm từng PNG gốc, mask và thông tin layer.');}
  catch(e){error(e.message);}finally{saving=false;syncInspector();}
});
document.addEventListener('keydown',event=>{
  if(saving)return;
  if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?draft()?.history.redo():draft()?.history.undo();rebuild();syncInspector();}
  if(event.key==='Escape')clearPolygon();
});
window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
async function start(){
  if(!id||!/^[a-f0-9-]{36}$/.test(id)){error('Mở trình sửa từ một lượt quét có kết quả.');status('Chưa có lượt quét.');return;}
  $('backToScan').href=`/?job=${encodeURIComponent(id)}`;
  try{const value=await json(base());if(!['done','partial'].includes(value.status))throw new Error('Lượt quét cần hoàn tất trước khi sửa layer.');adoptJob(value);bitmap(job.previewUrl,2048).then(image=>{underlay=image;redraw();}).catch(e=>error(e.message));const wanted=new URLSearchParams(location.search).get('element'),initial=initialLayerId(job.elements,wanted);if(initial)await select(initial);else status('Chưa có element; có thể nhập ảnh gốc để tạo layer.');}
  catch(e){error(e.message);status('Chưa mở được lượt quét.');}
}
start();
