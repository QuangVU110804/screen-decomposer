import { json, request } from './api.js';
import { rectangleFromPoints } from './watermark-selection.mjs';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const coordinates = ['wmX', 'wmY', 'wmWidth', 'wmHeight'];
let file, sourceUrl, resultUrl, width=0, height=0, regions=[], editing, drag, busy, controller, loadToken=0, showingResult=false, loading=false;
const status = message => { $('wmStatus').textContent=message; };
function error(message='') { $('wmError').textContent=message; $('wmError').hidden=!message; }

function show(result) {
  showingResult = Boolean(result && resultUrl);
  if (sourceUrl) $('wmImage').src=showingResult?resultUrl:sourceUrl;
  $('wmImage').alt=showingResult?'Kết quả xóa watermark/logo':'Ảnh gốc để khoanh vùng watermark';
  $('wmOriginal').setAttribute('aria-pressed',String(!showingResult));
  $('wmResult').setAttribute('aria-pressed',String(showingResult));
  $('wmOverlay').toggleAttribute('hidden',showingResult);
}
function invalidate() {
  show(false);
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl=undefined; $('wmDownload').hidden=true; $('wmDownload').removeAttribute('href');
}
function rectangle(box, draft=false) {
  const element=document.createElementNS(svgNS,'rect');
  ['x','y','width','height'].forEach((key,i)=>element.setAttribute(key,box[i]));
  if(draft)element.classList.add('wm-draft');
  return element;
}
function overlay() {
  $('wmOverlay').replaceChildren(...regions.map(region => {
    const element = rectangle(region.box);
    element.classList.toggle('wm-editing', region === editing);
    return element;
  }));
  if(drag) {
    const box=rectangleFromPoints(drag.start,drag.end,width,height);
    if(box)$('wmOverlay').append(rectangle(box,true));
  }
}
function controls() {
  const locked=busy||loading;
  for(const id of [...coordinates,'wmAdd','wmOriginal','wmDetect'])$(id).disabled=locked||!file;
  $('wmRemove').disabled=locked||!file||!regions.length||Boolean(editing);
  $('wmResult').disabled=locked||!resultUrl;
  $('wmClear').disabled=locked||!regions.length;
  $('wmChoose').disabled=locked; $('wmReplace').disabled=locked; $('wmFile').disabled=locked;
  $('wmCancel').hidden=!busy;
  $('wmDetect').textContent=busy==='detect'?'Đang dò trên máy…':'Dò watermark';
  $('wmRemove').textContent=busy==='remove'?'Đang điền nền local…':'Xóa watermark / logo';
  $('wmAdd').textContent=editing?'Lưu vùng':'Thêm vùng';
  $('wmCancelEdit').hidden=!editing;
  $('wmCancelEdit').disabled=locked;
  $('wmStage').setAttribute('aria-busy',String(Boolean(busy)));
  $('wmCount').textContent=regions.length;
  const area=regionArea();
  $('wmArea').textContent=file?`${regions.length}/20 khung · ${(area/(width*height)*100).toFixed(1)}% ảnh · tối đa 20% / 1 triệu pixel.`:'Tối đa 20 khung · tổng diện tích ≤20% ảnh / 1 triệu pixel.';
  $('wmRegionEmpty').hidden=regions.length>0;
  $('wmRegions').replaceChildren(...regions.map((region,index)=>{
    const [x,y,w,h] = region.box;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${index+1}. ${region.label} · (${x}, ${y}) · ${w} × ${h} px`;
    const actions = document.createElement('div');
    actions.className = 'wm-region-actions';
    for (const [name, action] of [['Sửa', () => editRegion(region)], ['Bỏ', () => removeRegion(region)]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = name;
      button.disabled = locked;
      button.setAttribute('aria-label', `${name} vùng ${index+1}`);
      button.addEventListener('click', action);
      actions.append(button);
    }
    li.append(label, actions);
    return li;
  }));
}
function refresh() { overlay(); controls(); }
function regionArea(except) {
  return regions.reduce((area, region) => region === except ? area : area + region.box[2]*region.box[3], 0);
}
function validBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isSafeInteger)) return false;
  const [x,y,w,h] = box;
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x+w <= width && y+h <= height;
}
function editRegion(region) {
  editing = region;
  show(false);
  $('wmCoordinates').open = true;
  coordinates.forEach((id, i) => { $(id).value = region.box[i]; });
  refresh();
  $('wmX').focus();
  status('Nhập tọa độ hoặc kéo lại trên ảnh để thay khung này.');
}
function removeRegion(region) {
  regions = regions.filter(item => item !== region);
  if (editing === region) editing = undefined;
  invalidate(); error(); refresh(); status('Đã bỏ vùng.');
}
function saveRegion(box) {
  if (!file || busy || loading || !box) return;
  if (!validBox(box)) return error('Nhập tọa độ nguyên và kích thước nằm trong ảnh.');
  if (!editing && regions.length >= 20) return error('Tối đa 20 vùng xóa mỗi lần.');
  if (regionArea(editing) + box[2]*box[3] > Math.min(width*height*.2, 1_000_000)) {
    return error('Tổng các khung tối đa 20% ảnh và 1 triệu pixel. Hãy khoanh sát logo hơn.');
  }
  if (editing) editing.box = box;
  else regions.push({box, label:'Thủ công'});
  editing = undefined;
  invalidate(); error(); refresh(); status('Đã lưu vùng. Kiểm tra khung trước khi xóa.');
}
function overlaps(a, b) {
  const w = Math.max(0, Math.min(a[0]+a[2], b[0]+b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1]+a[3], b[1]+b[3]) - Math.max(a[1], b[1]));
  return w*h >= .55*Math.min(a[2]*a[3], b[2]*b[3]);
}
async function detectRegions() {
  if (!file || busy || loading) return;
  busy = 'detect';
  controller = new AbortController();
  cancelDrag(); error(); controls(); status('Đang dò biểu tượng và chữ trên máy…');
  try {
    const form = new FormData();
    form.append('file', file);
    const found = await json('/api/watermark/detect', {method:'POST', body:form, signal:controller.signal});
    if (controller.signal.aborted) { status('Đã hủy dò watermark.'); return; }
    if (found.width !== width || found.height !== height) throw new Error('Kích thước ảnh xem trước khác ảnh chuẩn hóa. Hãy khoanh vùng thủ công.');
    const previousCount = regions.length;
    for (const suggestion of found.suggestions) {
      const {box} = suggestion;
      if (regions.length >= 20) break;
      if (!validBox(box) || regions.some(region => overlaps(region.box, box))) continue;
      if (regionArea() + box[2]*box[3] > Math.min(width*height*.2, 1_000_000)) continue;
      regions.push(suggestion);
    }
    const added = regions.length - previousCount;
    if (added) invalidate();
    status(`${added ? `Có ${added} vùng gợi ý. Kiểm tra và chỉnh trước khi xóa.` : 'Không tìm thấy vùng mới. Bạn có thể kéo để khoanh thêm.'} ${found.warnings.join(' ')}`.trim());
  } catch (e) {
    if (e.name !== 'AbortError') error(e.message);
    status(e.name === 'AbortError' ? 'Đã hủy dò watermark.' : 'Chưa dò được watermark. Bạn vẫn có thể khoanh vùng.');
  } finally {
    busy = undefined; controller = undefined; refresh();
  }
}
async function choose(candidate) {
  if(!candidate||busy)return;
  const token=++loadToken;
  if(candidate.size>20*1024*1024)return error('Ảnh vượt giới hạn 20 MB.');
  if(candidate.type&&!['image/jpeg','image/png','image/webp'].includes(candidate.type))return error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP tĩnh.');
  let url, loaded = false;
  loading=true; controls(); error(); status('Đang đọc ảnh…');
  try {
    url=URL.createObjectURL(candidate);
    const image=new Image();image.src=url;await image.decode();
    if(token!==loadToken)return;
    if(image.naturalWidth*image.naturalHeight>24_000_000)throw new Error('Ảnh vượt giới hạn 24 megapixel.');
    invalidate();if(sourceUrl)URL.revokeObjectURL(sourceUrl);
    sourceUrl=url;url=undefined;file=candidate;width=image.naturalWidth;height=image.naturalHeight;regions=[];editing=undefined;drag=undefined;
    $('wmOverlay').setAttribute('viewBox',`0 0 ${width} ${height}`);
    $('wmOverlay').setAttribute('preserveAspectRatio','none');
    $('wmImage').src=sourceUrl;
    $('wmDimensions').textContent=`${width} × ${height} px`;
    $('wmName').textContent=candidate.name;
    $('wmEmpty').hidden=true;$('wmStage').hidden=false;$('wmReplace').hidden=false;
    $('wmWidth').value=Math.min(60,width);$('wmHeight').value=Math.min(30,height);
    $('wmX').value=0;$('wmY').value=0;
    show(false);loaded = true;
  }catch(e){if(token===loadToken){error(e.message||'Không đọc được ảnh.');status('Không đọc được ảnh mới. Hãy chọn ảnh khác.');}}
  finally{if(url)URL.revokeObjectURL(url);if(token===loadToken){loading=false;refresh();if(loaded)void detectRegions();}}
}
function position(event) {
  const box=$('wmOverlay').getBoundingClientRect();
  return [Math.max(0,Math.min(width,(event.clientX-box.left)*width/box.width)),Math.max(0,Math.min(height,(event.clientY-box.top)*height/box.height))];
}
function cancelDrag() {drag=undefined;overlay();}
$('wmOverlay').addEventListener('pointerdown',event=>{
  if(!file||busy||loading||showingResult||!event.isPrimary||event.button!==0)return;
  event.preventDefault();const point=position(event);drag={start:point,end:point,pointerId:event.pointerId};
  $('wmOverlay').setPointerCapture(event.pointerId);overlay();
});
$('wmOverlay').addEventListener('pointermove',event=>{if(drag&&drag.pointerId===event.pointerId){drag.end=position(event);overlay();}});
$('wmOverlay').addEventListener('pointerup',event=>{
  if(!drag||drag.pointerId!==event.pointerId)return;
  const box=rectangleFromPoints(drag.start,position(event),width,height);
  cancelDrag();if($('wmOverlay').hasPointerCapture(event.pointerId))$('wmOverlay').releasePointerCapture(event.pointerId);
  saveRegion(box);
});
$('wmOverlay').addEventListener('pointercancel',cancelDrag);
$('wmOverlay').addEventListener('lostpointercapture',cancelDrag);
document.addEventListener('keydown',event=>{if(event.key==='Escape')cancelDrag();});
$('wmCoordinateForm').addEventListener('submit',event=>{event.preventDefault();saveRegion(coordinates.map(id=>$(id).valueAsNumber));});
$('wmCancelEdit').addEventListener('click',()=>{editing=undefined;refresh();status('Đã hủy chỉnh khung.');});
$('wmClear').addEventListener('click',()=>{if(busy||loading)return;regions=[];editing=undefined;invalidate();error();refresh();status('Đã bỏ các vùng chọn.');});
$('wmDetect').addEventListener('click', detectRegions);
for(const id of ['wmChoose','wmReplace'])$(id).addEventListener('click',()=>$('wmFile').click());
$('wmFile').addEventListener('change',()=>{choose($('wmFile').files[0]);$('wmFile').value='';});
$('wmOriginal').addEventListener('click',()=>show(false));
$('wmResult').addEventListener('click',()=>show(true));
$('wmCancel').addEventListener('click',()=>{controller?.abort();status('Đang hủy xử lý…');});
$('wmRemove').addEventListener('click',async()=>{
  if(!file||!regions.length||busy||loading)return;
  invalidate();error();busy='remove';controller=new AbortController();cancelDrag();controls();status('Đang điền nền bằng CPU local. Có thể hủy.');
  try {
    const form=new FormData();form.append('file',file);form.append('regions',JSON.stringify(regions.map(region => region.box)));
    const response=await request('/api/watermark/remove',{method:'POST',body:form,signal:controller.signal});
    const blob=await response.blob();if(controller.signal.aborted){status('Đã hủy. Ảnh gốc được giữ nguyên.');return;}
    resultUrl=URL.createObjectURL(blob);$('wmDownload').href=resultUrl;$('wmDownload').hidden=false;
    $('wmDownload').download=`${file.name.replace(/\.[^.]*$/,'')}-cleaned.png`;
    show(true);status('Đã xử lý. Chuyển Ảnh gốc / Sau khi xóa để so sánh rồi tải PNG.');
  }catch(e){if(e.name==='AbortError')status('Đã hủy. Ảnh gốc được giữ nguyên.');else{error(e.message);status('Xử lý chưa thành công. Kiểm tra vùng chọn rồi thử lại.');}}
  finally{busy=undefined;controller=undefined;controls();}
});
window.addEventListener('pagehide',()=>{controller?.abort();if(sourceUrl)URL.revokeObjectURL(sourceUrl);if(resultUrl)URL.revokeObjectURL(resultUrl);});
refresh();
