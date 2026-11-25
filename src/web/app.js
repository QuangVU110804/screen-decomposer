import { json, post, patch, request } from './modules/api.js';
import { renderOverlay } from './modules/preview.js';
import { renderGallery } from './modules/gallery.js';
import {elementMatchesFilter} from './modules/element-types.mjs';
const $ = id => document.getElementById(id);
const terminal = new Set(['done', 'partial', 'failed', 'canceled']);
const stageNames = { queued: 'Đang chờ lượt quét', text: 'Đang tìm vùng chữ', masks: 'Đang quét vùng ảnh', refining:'Đang ghép và hoàn thiện element', export: 'Đang xuất element', canceled: 'Đã hủy', failed: 'Quét không thành công', done: 'Hoàn tất', partial: 'Có kết quả cần kiểm tra' };
let file, objectUrl, job, filter = 'all', focusedId, ready = false, busy = false, pollTimer, pollFailures = 0, viewToken = 0, uploadController, toastTimer;
const pendingSelections = new Set();
let exporting = false;
const visibleElements = () => (job?.elements || []).filter(element => elementMatchesFilter(element, filter));
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function busyState() {
  busy = Boolean(uploadController || (job && !terminal.has(job.status)));
  $('scan').hidden = Boolean(job);
  $('scan').disabled = !file || !ready || busy;
  $('preset').disabled = busy;
  $('newImage').disabled = busy; $('chooseFile').disabled = busy; $('replaceFile').disabled = busy;
  $('retry').hidden = !job || !terminal.has(job.status);
  $('retry').disabled = !ready || busy;
  $('cancel').disabled = Boolean(uploadController);
  $('export').disabled = busy || exporting || pendingSelections.has(job?.id) || !job?.elements?.some(e => e.selected !== false);
  $('editLayers').hidden = busy || !job?.elements?.length;
  $('editLayers').href=job?`/editor.html?job=${encodeURIComponent(job.id)}`:'#';
  for (const item of $('history').querySelectorAll('[data-job-id]')) {
    const current = item.dataset.jobId === job?.id;
    item.disabled = busy;
    item.classList.toggle('active', current);
    if (current) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
  }
}
async function checkEngine() {
  try {
    const status = await json('/api/engine/status'); ready = Boolean(status.ready || status.segmentation || status.text);
    $('engineStatus').textContent = status.ready ? 'Xử lý trên máy' : ready ? 'Bộ xử lý sẵn sàng một phần' : 'Cần cài bộ xử lý local';
    $('engineStatus').className = 'engine-status ' + (status.ready ? 'ready' : 'unready');
    $('setupNotice').hidden = status.ready; busyState();
  } catch (e) { error(e.message); }
}
function reset() {
  viewToken++; clearTimeout(pollTimer); file = null; job = null; focusedId = null; filter = 'all';
  history.replaceState(null,'','/');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  $('fileInput').value = ''; $('dropzone').hidden = false; $('sourceStage').hidden = true;
  $('replaceFile').hidden = true; $('overlayControl').hidden = true; $('processing').hidden = true;
  $('documentName').textContent = 'Ảnh mới'; $('imageSize').textContent = ''; $('sourceCaption').textContent = 'Ảnh được xử lý ngay trên máy.';
  $('warnings').hidden = true; error(''); render();
}
function choose(selected) {
  if (!selected || busy) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) return error('Chọn ảnh JPG, PNG hoặc WebP.');
  if (selected.size > 20 * 1024 * 1024) return error('Ảnh vượt giới hạn 20 MB.');
  reset(); file = selected; objectUrl = URL.createObjectURL(file);
  $('sourceImage').src = objectUrl; $('documentName').textContent = file.name;
  $('dropzone').hidden = true; $('sourceStage').hidden = false; $('replaceFile').hidden = false;
  $('sourceCaption').textContent = 'Ảnh đã sẵn sàng để quét.';
  busyState();
  if (!$('scan').disabled) $('scan').focus();
}
function showJob(value) {
  if (job?.id !== value.id) {
    focusedId = null;
    filter = 'all';
    $('preset').value = value.preset;
  }
  job = value; $('documentName').textContent = job.name; $('sourceImage').src = job.previewUrl;
  job.elements.forEach((element, index) => { element.number = index + 1; });
  history.replaceState(null,'',`/?job=${encodeURIComponent(job.id)}`);
  $('dropzone').hidden = true; $('sourceStage').hidden = false; $('replaceFile').hidden = false;
  $('imageSize').textContent = `${job.source.width} × ${job.source.height}`;
  $('processing').hidden = terminal.has(job.status);
  $('stageText').textContent = stageNames[job.stage] || 'Đang xử lý';
  $('stageDetail').textContent = job.foundCount ? `${job.foundCount} vùng được đề xuất` : 'Lần đầu có thể lâu hơn do nạp model';
  $('progress').value = job.progress || 0;
  $('sourceCaption').textContent = job.cacheHit ? 'Đã dùng kết quả quét lưu trên máy.' : terminal.has(job.status) ? `${stageNames[job.status]}${job.timings?.jobMs ? ` · ${(job.timings.jobMs / 1000).toFixed(1)} giây` : ''}` : 'Giữ trang mở trong khi quét. Bạn có thể hủy bất cứ lúc nào.';
  $('warnings').textContent = (job.warnings || []).join(' '); $('warnings').hidden = !job.warnings?.length;
  error(job.status === 'failed' ? job.error : ''); render();
}
function render() {
  busyState();
  const elements = job?.elements || [], visible = visibleElements();
  $('resultCount').textContent = elements.length;
  $('resultControls').hidden = !elements.length;
  $('overlayControl').hidden = !elements.some(element => !element.imported);
  $('emptyResults').hidden = visible.length > 0;
  const emptyTitle = $('emptyResults').querySelector('h3'), emptyCopy = $('emptyResults').querySelector('p');
  if (busy) { emptyTitle.textContent = 'Đang quét ảnh'; emptyCopy.textContent = 'Kết quả sẽ xuất hiện khi quét xong.'; }
  else if (['done', 'partial'].includes(job?.status) && !elements.length) { emptyTitle.textContent = 'Chưa tìm được vùng phù hợp'; emptyCopy.textContent = 'Thử chế độ Kỹ hoặc một ảnh rõ hơn.'; }
  else if (elements.length && !visible.length) { emptyTitle.textContent = 'Bộ lọc này không có kết quả'; emptyCopy.textContent = 'Chọn Tất cả để xem các vùng còn lại.'; }
  else { emptyTitle.textContent = 'Chưa có kết quả'; emptyCopy.textContent = 'Thêm ảnh và bấm Quét ảnh.'; }
  for (const button of document.querySelectorAll('[data-filter]')) {
    const active = filter === button.dataset.filter;
    const count = elements.filter(e => elementMatchesFilter(e, button.dataset.filter)).length;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = `${{all: 'Tất cả', region: 'Vùng ảnh', 'text-region': 'Vùng chữ'}[button.dataset.filter]} ${count}`;
  }
  renderGallery($('gallery'), visible, { onSelect: (element, selected) => saveSelection([element], selected), onOpen: openDetail, onHighlight: highlight });
  renderOverlay($('overlay'), job?.source, visible);
  highlight();
  renderSelection();
}
function highlight(id) {
  const visible = visibleElements();
  const activeId = document.activeElement.closest('#gallery [data-element-id]')?.dataset.elementId;
  const element = visible.find(e => e.id === (id || activeId || focusedId)) || visible[0];
  for (const item of document.querySelectorAll('#overlay [data-element-id], #gallery [data-element-id]')) {
    item.classList.toggle('focused', item.dataset.elementId === element?.id);
  }
  $('sourceRegion').hidden = !element || $('overlayMode').value === 'off';
  $('sourceRegion').textContent = element ? `Vùng ${element.number} · ${element.label}${element.imported ? ' (ảnh bổ sung)' : ''}` : '';
}
function renderSelection() {
  const visible = visibleElements(), saving = pendingSelections.has(job?.id);
  const visibleSelected = visible.filter(e => e.selected !== false).length;
  const total = job?.elements?.filter(e => e.selected !== false).length || 0;
  for (const card of $('gallery').children) {
    const checkbox = card.querySelector('input');
    checkbox.checked = visible.find(element => element.id === card.dataset.elementId).selected !== false;
    checkbox.setAttribute('aria-disabled', String(saving));
  }
  $('visibleCount').textContent = `${visibleSelected}/${visible.length} vùng đang chọn`;
  $('selectionCount').textContent = total ? `${total} vùng sẽ tải` : 'Chưa chọn vùng để tải';
  $('selectAll').disabled = !visible.length || busy;
  $('selectAll').setAttribute('aria-disabled', String(saving));
  const unselect = visible.length && visibleSelected === visible.length;
  $('selectAll').textContent = unselect ? 'Bỏ chọn hết' : 'Chọn hết';
  $('selectAll').setAttribute('aria-label', unselect ? 'Bỏ chọn mọi vùng trong bộ lọc này' : 'Chọn mọi vùng trong bộ lọc này');
  busyState();
}
async function saveSelection(elements, selected) {
  const target = job;
  if (!target || busy || pendingSelections.has(target.id) || !elements.length) return renderSelection();
  pendingSelections.add(target.id);
  const previous = elements.map(element => element.selected);
  elements.forEach(element => { element.selected = selected; });
  renderSelection();
  try {
    const ids = elements.map(element => element.id);
    await patch(`/api/jobs/${target.id}/selection`, { ids, selected });
    if (job?.id === target.id && job !== target) {
      for (const element of job.elements) if (ids.includes(element.id)) element.selected = selected;
    }
  }
  catch (e) {
    elements.forEach((element, index) => { element.selected = previous[index]; });
    if (job?.id === target.id) error(e.message);
  } finally {
    pendingSelections.delete(target.id);
    if (job?.id === target.id) renderSelection();
  }
}
function openDetail(element) {
  focusedId = element.id; highlight();
  $('detailTitle').textContent = `${element.number}. ${element.label}`; $('detailImage').src = element.url;
  $('elementLabel').value = element.label; $('detailDimensions').textContent = `${element.bbox[2]} × ${element.bbox[3]} px`;
  $('renameStatus').textContent = ''; $('elementLabel').removeAttribute('aria-invalid');
  $('detailWarning').textContent = element.edgeWarning || 'Kiểm tra lại vùng tách trước khi tái sử dụng.';
  $('downloadElement').href = element.url; $('downloadElement').download = element.id + '.png';
  $('editElement').href=`/editor.html?job=${encodeURIComponent(job.id)}&element=${encodeURIComponent(element.id)}`;
  $('locateRegion').hidden = Boolean(element.imported);
  $('detailDialog').returnValue = '';
  $('detailDialog').showModal();
}
function schedulePoll(token, id, delay = 1200) {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(async () => {
    try {
      const value = await json(`/api/jobs/${id}`);
      if (token !== viewToken) return;
      pollFailures = 0; showJob(value);
      if (!terminal.has(value.status)) schedulePoll(token, id);
      else await loadHistory();
    } catch (e) {
      if (token !== viewToken) return;
      pollFailures++; error(e.message); schedulePoll(token, id, Math.min(12000, 1500 * 2 ** Math.min(pollFailures, 3)));
    }
  }, delay);
}
async function scan() {
  if (!file || busy || !ready) return;
  error(''); const token = ++viewToken;
  uploadController = new AbortController(); render();
  $('processing').hidden = false; $('stageText').textContent = 'Đang nhận và kiểm tra ảnh'; $('stageDetail').textContent = ''; $('progress').value = 5;
  const body = new FormData(); body.append('file', file); body.append('preset', $('preset').value);
  try {
    const value = await json('/api/images', { method: 'POST', body, signal: uploadController.signal });
    if (token !== viewToken) return;
    uploadController = null; showJob(value); schedulePoll(token, value.id, 100); await loadHistory();
  } catch (e) { if (e.name !== 'AbortError') error(e.message); $('processing').hidden = true; }
  finally { uploadController = null; render(); }
}
async function loadHistory() {
  try {
    const { jobs } = await json('/api/jobs?limit=20'); const fragment = document.createDocumentFragment();
    for (const item of jobs) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
      button.dataset.jobId = item.id;
      const img = document.createElement('img'); img.src = item.previewUrl; img.alt = ''; img.loading = 'lazy';
      const text = document.createElement('span'); text.className = 'history-text';
      const name = document.createElement('span'); name.className = 'history-name'; name.textContent = item.name;
      const meta = document.createElement('span'); meta.className = 'history-meta'; meta.textContent = `${stageNames[item.status] || 'Đang quét'} · ${item.count} vùng`;
      text.append(name, meta); button.append(img, text);
      button.addEventListener('click', async () => {
        try { reset(); document.querySelector('.sidebar').classList.remove('history-open'); $('toggleHistory').setAttribute('aria-expanded','false'); $('workspace').focus(); const token = ++viewToken; const value = await json(`/api/jobs/${item.id}`); if (token !== viewToken) return; showJob(value); if (!terminal.has(value.status)) schedulePoll(token, value.id); }
        catch (e) { error(e.message); }
      }); fragment.append(button);
    }
    if (jobs.length) { $('history').replaceChildren(fragment); busyState(); }
  } catch (e) { error(e.message); }
}
for (const id of ['chooseFile', 'replaceFile', 'newImage']) {
  $(id).addEventListener('click', () => { $('fileInput').value = ''; $('fileInput').click(); });
}
$('fileInput').addEventListener('change', e => choose(e.target.files[0]));
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); if (type === 'drop') choose(e.dataTransfer.files[0]); });
$('scan').addEventListener('click', scan);
$('cancel').addEventListener('click', async () => {
  if (uploadController) return;
  if (!job) return;
  try { const value = await post(`/api/jobs/${job.id}/cancel`); clearTimeout(pollTimer); showJob(value); await loadHistory(); }
  catch (e) { error(e.message); }
});
$('retry').addEventListener('click', async () => {
  if (!job || busy) return;
  try { const value = await post(`/api/jobs/${job.id}/retry`, { preset: $('preset').value }); viewToken++; showJob(value); schedulePoll(viewToken, value.id, 100); loadHistory(); }
  catch (e) { error(e.message); }
});
$('export').addEventListener('click', async () => {
  if (!job || exporting || pendingSelections.has(job.id)) return;
  const target = job;
  exporting = true; busyState();
  $('export').textContent = 'Đang chuẩn bị ZIP…';
  try {
    const response = await request(`/api/jobs/${target.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: target.elements.filter(e => e.selected !== false).map(e => e.id) }) });
    const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = `elements-${target.id.slice(0,8)}.zip`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('Đã chuẩn bị ZIP để tải xuống.');
  } catch (e) { error(e.message); }
  finally { exporting = false; $('export').textContent = 'Tải ZIP'; busyState(); }
});
$('selectAll').addEventListener('click', () => {
  const visible = visibleElements();
  saveSelection(visible, !visible.every(e => e.selected !== false));
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $('gallery').scrollTop = 0;
  render();
}));
$('overlayMode').addEventListener('change', event => { $('overlay').dataset.mode = event.target.value; highlight(); });
$('closeDialog').addEventListener('click', () => $('detailDialog').close());
$('locateRegion').addEventListener('click', () => $('detailDialog').close('source'));
$('detailDialog').addEventListener('close', () => {
  if ($('detailDialog').returnValue === 'source') {
    if ($('overlayMode').value === 'off') $('overlay').dataset.mode = $('overlayMode').value = 'focus';
    $('sourceHeading').focus({ preventScroll: true });
    $('sourceHeading').scrollIntoView({ block: 'start' });
    highlight(focusedId);
    return;
  }
  if (focusedId) $('gallery').querySelector(`[data-element-id="${CSS.escape(focusedId)}"] .asset-preview`)?.focus();
});
$('detailDialog').addEventListener('click', e => { if (e.target === $('detailDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
let background = 0;
$('switchBackground').addEventListener('click', () => { background = (background + 1) % 3; $('detailBackground').className = 'detail-image ' + ['checker','light','dark'][background]; });
$('renameForm').addEventListener('submit', async e => {
  e.preventDefault(); const element = job.elements.find(x => x.id === focusedId); if (!element) return;
  const label = $('elementLabel').value.trim();
  const status = $('renameStatus');
  if (!label) {
    status.classList.add('invalid'); status.textContent = 'Nhập tên vùng.';
    $('elementLabel').setAttribute('aria-invalid', 'true'); $('elementLabel').focus(); return;
  }
  $('elementLabel').removeAttribute('aria-invalid');
  const target = job;
  status.classList.remove('invalid');
  status.textContent = 'Đang lưu…';
  try {
    await patch(`/api/jobs/${target.id}/elements/${element.id}`, { label });
    element.label = label;
    if (job !== target) return;
    if (focusedId === element.id) {
      $('detailTitle').textContent = `${element.number}. ${element.label}`;
      status.textContent = 'Đã lưu tên vùng.';
    }
    render();
  } catch (err) {
    if (job === target && focusedId === element.id) {
      status.classList.add('invalid'); status.textContent = err.message;
    }
  }
});
$('checkEngine').addEventListener('click', checkEngine); $('refreshHistory').addEventListener('click', loadHistory);
$('toggleHistory').addEventListener('click',()=>{const open=document.querySelector('.sidebar').classList.toggle('history-open');$('toggleHistory').setAttribute('aria-expanded',String(open));if(open)loadHistory();});
document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden && job && !terminal.has(job.status)) schedulePoll(viewToken, job.id, 0); });
window.addEventListener('pagehide', () => { clearTimeout(pollTimer); if (objectUrl) URL.revokeObjectURL(objectUrl); });
render(); checkEngine(); loadHistory();
const savedJob=new URLSearchParams(location.search).get('job');
if (savedJob) {
  const token = viewToken;
  json(`/api/jobs/${encodeURIComponent(savedJob)}`).then(value => {
    if (token !== viewToken) return;
    showJob(value);
    if (!terminal.has(value.status)) schedulePoll(token, value.id);
  }).catch(e => { if (token === viewToken) error(e.message); });
}
