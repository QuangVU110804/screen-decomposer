(() => {
  'use strict';

  const STORAGE_KEY = 'lastJobId';
  const API_KEY_STORAGE_KEY = 'apiKey';
  const REVIEWER_ID_STORAGE_KEY = 'editorReviewerId';
  const POLL_INTERVAL_MS = 1500;
  const RETRY_INTERVAL_MS = 3000;
  const DEFAULT_CONFIG = {
    maxUploadMb: 500,
    maxDurationSec: 600,
    allowedExtensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'],
    authRequired: false,
    schemaVersion: 2,
    assetMinQuality: 0.48,
    assetReviewQuality: 0.68,
  };
  const STATUS_LABELS = {
    pending: 'Đang chờ…',
    downloading: 'Đang tải video…',
    uploading: 'Đang nhận file…',
    probing: 'Đang đọc metadata video…',
    detecting_scenes: 'Đang phân hoạch scene…',
    selecting_keyframes: 'Đang chọn keyframe…',
    understanding_scenes: 'Đang hiểu composition và element…',
    associating_elements: 'Đang liên kết element…',
    extracting_direct_assets: 'Đang crop direct asset…',
    segmenting: 'Đang tách foreground và alpha…',
    recovering_backgrounds: 'Đang phục hồi background…',
    validating_assets: 'Đang chấm điểm và kiểm tra asset…',
    deduplicating: 'Đang gộp asset trùng…',
    packaging: 'Đang đóng gói theo scene…',
    sampling: 'Đang lấy mẫu frame legacy…',
    filtering: 'Đang lọc frame legacy…',
    analyzing: 'Đang phân tích legacy…',
    finalizing: 'Đang hoàn tất legacy…',
    done: 'Hoàn tất',
    partial: 'Hoàn tất một phần',
    failed: 'Lỗi',
  };
  const STATUS_FINISHED = new Set(['done', 'partial', 'failed']);

  let config = { ...DEFAULT_CONFIG };
  let pollTimer = null;
  let activeJobId = null;
  let currentJob = null;
  let selectedSceneId = null;

  const $ = (id) => document.getElementById(id);
  const progressSection = $('progressSection');
  const resultSection = $('resultSection');
  const errorSection = $('errorSection');
  const progressBar = progressSection.querySelector('[role="progressbar"]');
  const progressFill = $('progressFill');
  const statusText = $('statusText');

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_error) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (_error) {}
  }

  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (_error) {}
  }

  function readStoredJobId() { return storageGet(STORAGE_KEY); }
  function getApiKey() { return storageGet(API_KEY_STORAGE_KEY) || ''; }
  function getReviewerId() {
    const stored = storageGet(REVIEWER_ID_STORAGE_KEY);
    if (stored) return stored;
    const generated = `editor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    storageSet(REVIEWER_ID_STORAGE_KEY, generated);
    return generated;
  }
  function storeJobId(jobId) { storageSet(STORAGE_KEY, jobId); }
  function forgetStoredJobId() { storageRemove(STORAGE_KEY); }

  function clearPollTimer() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function showSection(name) {
    const sections = { progress: progressSection, result: resultSection, error: errorSection };
    Object.entries(sections).forEach(([key, section]) => section.classList.toggle('hidden', key !== name));
  }

  function showError(message, { forgetJob = true } = {}) {
    clearPollTimer();
    activeJobId = null;
    if (forgetJob) forgetStoredJobId();
    $('errorText').textContent = String(message || 'Đã xảy ra lỗi.');
    showSection('error');
  }

  function setTab(tabName) {
    const isUpload = tabName === 'upload';
    $('tab-url').classList.toggle('active', !isUpload);
    $('tab-upload').classList.toggle('active', isUpload);
    $('tab-url').setAttribute('aria-selected', String(!isUpload));
    $('tab-upload').setAttribute('aria-selected', String(isUpload));
    $('panel-url').classList.toggle('hidden', isUpload);
    $('panel-upload').classList.toggle('hidden', !isUpload);
    $('panel-url').setAttribute('aria-hidden', String(isUpload));
    $('panel-upload').setAttribute('aria-hidden', String(!isUpload));
  }

  function setSubmitBusy(busy) {
    $('submitUrl').disabled = busy;
    $('urlInput').disabled = busy;
    $('dropzone').classList.toggle('busy', busy);
    $('fileInput').disabled = busy;
  }

  function authHeaders() {
    if (!config.authRequired) return {};
    const key = getApiKey();
    return key ? { 'X-API-Key': key } : {};
  }

  function showAuthPrompt(required) {
    $('authSection').classList.toggle('hidden', !required);
    if (required) $('apiKeyInput').value = getApiKey();
  }

  async function loadConfig() {
    let data = {};
    try {
      let response = await window.fetch('/api/v2/config');
      if (!response.ok) response = await window.fetch('/api/config');
      if (!response.ok) throw new Error('config request failed');
      data = await response.json();
    } catch (_error) {
      data = {};
    }
    config = {
      ...DEFAULT_CONFIG,
      ...data,
      maxUploadMb: Number(data.maxUploadMb) || DEFAULT_CONFIG.maxUploadMb,
      maxDurationSec: Number(data.maxDurationSec) || DEFAULT_CONFIG.maxDurationSec,
      authRequired: Boolean(data.authRequired),
    };
    const minutes = Math.round(config.maxDurationSec / 60);
    const extensions = config.allowedExtensions.map((extension) => `.${extension}`).join(', ');
    $('uploadHint').textContent = `Tối đa ${config.maxUploadMb}MB, video dài tối đa ${minutes} phút. Định dạng: ${extensions}.`;
    showAuthPrompt(config.authRequired);
  }

  async function readJson(response) {
    try { return await response.json(); } catch (_error) { return {}; }
  }

  function startJob(jobId) {
    if (!jobId) return showError('Server không trả về mã job hợp lệ.');
    activeJobId = String(jobId);
    selectedSceneId = null;
    storeJobId(activeJobId);
    showSection('progress');
    void poll(activeJobId);
  }

  function schedulePoll(jobId, delay) {
    clearPollTimer();
    pollTimer = window.setTimeout(() => poll(jobId), delay);
  }

  async function poll(jobId) {
    clearPollTimer();
    if (activeJobId !== jobId) return;
    try {
      const response = await window.fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (activeJobId !== jobId) return;
      if (response.status === 404) {
        activeJobId = null;
        forgetStoredJobId();
        return showError('Job không tồn tại hoặc đã hết thời gian lưu.');
      }
      if (!response.ok) {
        statusText.textContent = 'Kết nối tạm thời gặp lỗi — sẽ thử lại sau 3 giây.';
        return schedulePoll(jobId, RETRY_INTERVAL_MS);
      }
      const job = await response.json();
      currentJob = job;
      renderProgress(job);
      if (job.status === 'done' || job.status === 'partial') {
        activeJobId = null;
        forgetStoredJobId();
        await renderResult(job);
        return;
      }
      if (job.status === 'failed') {
        activeJobId = null;
        forgetStoredJobId();
        return showError(job.error || 'Xử lý thất bại.');
      }
      schedulePoll(jobId, POLL_INTERVAL_MS);
    } catch (_error) {
      if (activeJobId !== jobId) return;
      statusText.textContent = 'Mất kết nối tạm thời — sẽ thử lại sau 3 giây.';
      schedulePoll(jobId, RETRY_INTERVAL_MS);
    }
  }

  function renderProgress(job) {
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    progressFill.style.width = `${progress}%`;
    $('progressPercent').textContent = `${progress}%`;
    progressBar.setAttribute('aria-valuenow', String(progress));
    const queueHint = job.queuePosition > 0 ? ` — đang xếp hàng (#${job.queuePosition})` : '';
    statusText.textContent = `${STATUS_LABELS[job.stage] || STATUS_LABELS[job.status] || job.stage || job.status} (${progress}%)${queueHint}`;
  }

  function addText(parent, tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(value ?? '');
    parent.appendChild(element);
    return element;
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const remainder = value - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
  }

  async function renderResult(job) {
    clearPollTimer();
    showSection('result');
    if (Number(job.schemaVersion) === 2 && job.resultType === 'decomposer') {
      return renderDecomposer(job);
    }
    return renderLegacy(job);
  }

  async function renderDecomposer(job) {
    currentJob = job;
    const scenes = Array.isArray(job.scenes) ? job.scenes : [];
    const assets = Array.isArray(job.assets) ? job.assets : [];
    $('assetCount').textContent = `${job.assetCount ?? assets.length} reusable asset`;
    $('resultSummary').textContent = `${scenes.length} scene · ${job.failureCount || 0} cảnh báo · trạng thái ${job.status.toUpperCase()}`;
    $('downloadAllBtn').href = `/api/v2/jobs/${encodeURIComponent(job.id)}/download`;
    $('sceneCount').textContent = `${scenes.length} scene`;
    $('sceneWorkspace').classList.toggle('hidden', scenes.length === 0);
    $('assetFilters').classList.remove('hidden');
    $('sceneClipSection').classList.add('hidden');
    renderTimeline(scenes);
    renderFilteredAssets();
    if (scenes.length > 0) {
      const first = selectedSceneId && scenes.some((scene) => scene.sceneId === selectedSceneId)
        ? selectedSceneId
        : scenes[0].sceneId;
      await selectScene(first);
    }
  }

  function renderTimeline(scenes) {
    const timeline = $('sceneTimeline');
    timeline.replaceChildren();
    scenes.forEach((scene, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-chip';
      button.dataset.sceneId = scene.sceneId;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(scene.sceneId === selectedSceneId));
      addText(button, 'strong', null, `Scene ${index + 1}`);
      addText(button, 'span', null, `${formatTime(scene.start)}–${formatTime(scene.end)}`);
      addText(button, 'small', null, `${scene.elementCount || 0} element`);
      button.addEventListener('click', () => void selectScene(scene.sceneId));
      timeline.appendChild(button);
    });
  }

  async function selectScene(sceneId) {
    selectedSceneId = sceneId;
    document.querySelectorAll('.scene-chip').forEach((button) => {
      const selected = button.dataset.sceneId === sceneId;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    renderFilteredAssets();
    try {
      const response = await window.fetch(
        `/api/v2/jobs/${encodeURIComponent(currentJob.id)}/scenes/${encodeURIComponent(sceneId)}`
      );
      if (!response.ok) throw new Error('Không tải được chi tiết scene');
      renderSceneDetail(await response.json());
    } catch (error) {
      $('sceneDetail').classList.remove('hidden');
      $('sceneRange').textContent = error.message;
    }
  }

  function renderSceneDetail(scene) {
    $('sceneDetail').classList.remove('hidden');
    $('selectedSceneLabel').textContent = scene.sceneId;
    $('sceneRange').textContent = `${formatTime(scene.start)} → ${formatTime(scene.end)}`;
    $('sceneDownloadBtn').href =
      `/api/v2/jobs/${encodeURIComponent(currentJob.id)}/scenes/${encodeURIComponent(scene.sceneId)}/download`;
    const preview = $('scenePreview');
    preview.src = scene.previewUrl || '';
    preview.alt = `Preview ${scene.sceneId}`;

    const strip = $('keyframeStrip');
    strip.replaceChildren();
    (scene.keyframes || []).forEach((keyframe) => {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.src = keyframe.url || '';
      image.alt = `${keyframe.keyframeId} at ${formatTime(keyframe.timestamp)}`;
      image.loading = 'lazy';
      const caption = document.createElement('figcaption');
      caption.textContent = `${formatTime(keyframe.timestamp)} · ${(keyframe.selectionReason || []).join(', ')}`;
      figure.append(image, caption);
      strip.appendChild(figure);
    });

    const legend = $('elementLegend');
    legend.replaceChildren();
    (scene.elements || []).forEach((element) => {
      const badge = addText(legend, 'span', 'element-badge', `${element.type}: ${element.description || element.elementId}`);
      badge.title = `${element.extractability} · semantic ${Math.round((element.semanticConfidence || 0) * 100)}%`;
    });
  }

  function renderFilteredAssets() {
    const type = $('typeFilter').value;
    const mode = $('modeFilter').value;
    const minQuality = Number($('qualityFilter').value || 0);
    const sceneScope = $('sceneScopeFilter')?.value || 'selected';
    const assets = (currentJob?.assets || [])
      .filter((asset) => asset.qualityState !== 'failed')
      .filter((asset) => (
        sceneScope !== 'selected' ||
        !selectedSceneId ||
        (asset.occurrences || []).some((occurrence) => occurrence.sceneId === selectedSceneId)
      ))
      .filter((asset) => !type || asset.type === type)
      .filter((asset) => !mode || asset.extractionMode === mode)
      .filter((asset) => Number(asset.quality || 0) >= minQuality)
      .sort((left, right) => Number(right.quality || 0) - Number(left.quality || 0));
    $('visibleAssetCount').textContent = `${assets.length} hiển thị`;
    const grid = $('assetGrid');
    grid.replaceChildren();
    if (assets.length === 0) {
      addText(grid, 'p', 'empty', 'Không có asset phù hợp bộ lọc hoặc tất cả asset cần review chẩn đoán.');
      return;
    }
    assets.forEach((asset) => grid.appendChild(buildV2AssetCard(asset)));
  }

  function buildV2AssetCard(asset) {
    const card = document.createElement('article');
    card.className = `asset-card mode-${String(asset.extractionMode || '').toLowerCase()}`;
    const imageLink = document.createElement('a');
    imageLink.className = 'asset-image-link transparency-preview';
    imageLink.href = asset.files?.primaryUrl || '#';
    imageLink.target = '_blank';
    imageLink.rel = 'noopener noreferrer';
    const image = document.createElement('img');
    image.src = asset.files?.thumbnailUrl || asset.files?.primaryUrl || '';
    image.alt = asset.description || `${asset.type} ${asset.assetId}`;
    image.loading = 'lazy';
    imageLink.appendChild(image);
    card.appendChild(imageLink);

    const meta = document.createElement('div');
    meta.className = 'asset-meta';
    const badges = document.createElement('div');
    badges.className = 'asset-badges';
    addText(badges, 'span', 'badge type-badge', asset.type);
    addText(badges, 'span', `badge mode-badge mode-${String(asset.extractionMode).toLowerCase()}`, asset.extractionMode);
    meta.appendChild(badges);
    addText(meta, 'strong', 'asset-label', asset.description || asset.assetId);
    addText(meta, 'span', 'quality-label', `Quality ${Math.round(Number(asset.quality || 0) * 100)}% · ${asset.width}×${asset.height}`);
    if (asset.extractionMode === 'RECONSTRUCTED') {
      addText(
        meta,
        'p',
        'reconstruction-warning',
        `Approximation: ${Math.round(Number(asset.reconstructedAreaRatio || 0) * 100)}% generated, ` +
        `${Math.round(Number(asset.recoveryAreaRatio || 0) * 100)}% recovered.`
      );
    } else {
      addText(meta, 'p', 'desc', asset.source?.sceneId
        ? `Nguồn: ${asset.source.sceneId} · ${formatTime(asset.source.timestamp)}`
        : '');
    }
    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    const download = document.createElement('a');
    download.className = 'btn-small';
    download.href = asset.files?.primaryUrl || '#';
    download.setAttribute('download', `${asset.type}-${asset.assetId}.png`);
    download.textContent = 'Tải asset';
    download.addEventListener('click', () => void sendFeedback(asset.assetId, { downloaded: true }));
    actions.appendChild(download);
    if (asset.files?.maskUrl) {
      const mask = document.createElement('a');
      mask.className = 'btn-small secondary-plain';
      mask.href = asset.files.maskUrl;
      mask.target = '_blank';
      mask.rel = 'noopener noreferrer';
      mask.textContent = 'Xem mask';
      actions.appendChild(mask);
    }
    if (asset.files?.reconstructedMaskUrl) {
      const reconstructionMask = document.createElement('a');
      reconstructionMask.className = 'btn-small secondary-plain';
      reconstructionMask.href = asset.files.reconstructedMaskUrl;
      reconstructionMask.target = '_blank';
      reconstructionMask.rel = 'noopener noreferrer';
      reconstructionMask.textContent = 'Vùng reconstructed';
      actions.appendChild(reconstructionMask);
    }
    const useful = document.createElement('button');
    useful.type = 'button';
    useful.className = 'btn-small utility-positive';
    useful.textContent = 'Hữu ích';
    useful.addEventListener('click', async () => {
      if (!await sendFeedback(asset.assetId, { useful: true })) return;
      useful.disabled = true;
      notUseful.disabled = true;
      useful.textContent = 'Đã ghi nhận';
    });
    const notUseful = document.createElement('button');
    notUseful.type = 'button';
    notUseful.className = 'btn-small secondary-plain utility-negative';
    notUseful.textContent = 'Không hữu ích';
    notUseful.addEventListener('click', async () => {
      if (!await sendFeedback(asset.assetId, { useful: false })) return;
      useful.disabled = true;
      notUseful.disabled = true;
      notUseful.textContent = 'Đã ghi nhận';
    });
    actions.append(useful, notUseful);
    meta.appendChild(actions);
    card.appendChild(meta);
    return card;
  }

  async function sendFeedback(assetId, payload) {
    try {
      const response = await window.fetch(
        `/api/v2/jobs/${encodeURIComponent(currentJob.id)}/assets/${encodeURIComponent(assetId)}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ reviewerId: getReviewerId(), ...payload }),
        }
      );
      return response.ok;
    } catch (_error) {
      return false;
    }
  }

  function renderLegacy(job) {
    const assets = Array.isArray(job.assets) ? job.assets : [];
    const sceneClips = Array.isArray(job.sceneClips) ? job.sceneClips : [];
    $('assetCount').textContent = `${assets.length} legacy frame asset`;
    if ($('resultSummary')) {
      $('resultSummary').textContent = 'Kết quả v1 được giữ trong compatibility window; đây không phải scene decomposition.';
    }
    $('downloadAllBtn').href = `/api/jobs/${encodeURIComponent(job.id)}/download`;
    if ($('sceneWorkspace')) $('sceneWorkspace').classList.add('hidden');
    if ($('assetFilters')) $('assetFilters').classList.add('hidden');
    const grid = $('assetGrid');
    grid.replaceChildren();
    assets.forEach((asset, index) => {
      const card = document.createElement('article');
      card.className = 'asset-card';
      const image = document.createElement('img');
      image.src = asset.thumbUrl || asset.url || '';
      image.alt = asset.label || `Legacy asset ${index + 1}`;
      const link = document.createElement('a');
      link.className = 'asset-image-link';
      link.href = asset.url || '#';
      link.appendChild(image);
      const meta = document.createElement('div');
      meta.className = 'asset-meta';
      addText(meta, 'strong', 'asset-label', asset.label || `Asset ${index + 1}`);
      addText(meta, 'span', 'timecode', asset.timecode || '');
      addText(meta, 'p', 'desc', asset.description || '');
      card.appendChild(link);
      card.appendChild(meta);
      grid.appendChild(card);
    });
    if (assets.length === 0) addText(grid, 'p', 'empty', 'Legacy job không có asset.');
    if ($('sceneClipSection')) $('sceneClipSection').classList.toggle('hidden', sceneClips.length === 0);
  }

  async function submitUrl(event) {
    event.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) {
      showError('Nhập URL hoặc video ID trước.');
      $('urlInput').focus();
      return;
    }
    clearPollTimer();
    activeJobId = null;
    forgetStoredJobId();
    setSubmitBusy(true);
    try {
      const response = await window.fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ url }),
      });
      const data = await readJson(response);
      if (!response.ok) return showError(data.error || 'Lỗi không xác định.');
      startJob(data.jobId);
    } catch (error) {
      showError(`Không kết nối được server: ${error.message}`);
    } finally {
      setSubmitBusy(false);
    }
  }

  function showSelectedFile(file) {
    $('selectedFile').textContent = file ? `Đã chọn: ${file.name}` : '';
  }

  async function handleUpload(file) {
    if (!file) return;
    showSelectedFile(file);
    const ext = file.name.split('.').pop().toLowerCase();
    if (!config.allowedExtensions.includes(ext)) return showError(`Định dạng .${ext} không được hỗ trợ.`);
    if (file.size > config.maxUploadMb * 1024 * 1024) return showError(`File vượt quá ${config.maxUploadMb}MB.`);
    clearPollTimer();
    activeJobId = null;
    forgetStoredJobId();
    setSubmitBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await window.fetch('/api/extract/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      const data = await readJson(response);
      if (!response.ok) return showError(data.error || 'Lỗi upload.');
      startJob(data.jobId);
    } catch (error) {
      showError(`Không kết nối được server: ${error.message}`);
    } finally {
      setSubmitBusy(false);
    }
  }

  function watchJobById(jobId) {
    if (!jobId) return;
    activeJobId = String(jobId);
    storeJobId(activeJobId);
    showSection('progress');
    void poll(activeJobId);
  }

  async function renderHistory() {
    const list = $('historyList');
    let jobs = [];
    try {
      const response = await window.fetch('/api/jobs');
      if (!response.ok) throw new Error('history request failed');
      jobs = (await response.json()).jobs || [];
    } catch (_error) {
      list.replaceChildren();
      addText(list, 'p', 'empty', 'Không tải được lịch sử.');
      return;
    }
    jobs = jobs.filter((job) => job.id !== activeJobId);
    $('historySection').classList.toggle('hidden', jobs.length === 0);
    list.replaceChildren();
    jobs.slice(0, 20).forEach((job) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.setAttribute('role', 'listitem');
      addText(row, 'span', `badge badge-${job.status}`, STATUS_LABELS[job.status] || job.status);
      const kind = job.legacyFrameResult ? 'Legacy frame' : `${job.sceneCount || 0} scene`;
      addText(row, 'span', 'history-meta', `${kind} · ${job.assetCount || 0} asset · ${formatDate(job.createdAt)}`);
      const button = addText(row, 'button', 'btn-small', STATUS_FINISHED.has(job.status) ? 'Xem' : 'Theo dõi');
      button.type = 'button';
      button.addEventListener('click', () => watchJobById(job.id));
      list.appendChild(row);
    });
  }

  function formatDate(iso) {
    try { return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }); }
    catch (_error) { return ''; }
  }

  function retry() {
    clearPollTimer();
    activeJobId = null;
    currentJob = null;
    selectedSceneId = null;
    forgetStoredJobId();
    $('urlInput').value = '';
    $('fileInput').value = '';
    showSelectedFile(null);
    progressFill.style.width = '0%';
    $('progressPercent').textContent = '0%';
    statusText.textContent = 'Đang chuẩn bị…';
    showSection(null);
    setTab('url');
    $('urlInput').focus();
  }

  function bindEvents() {
    $('urlForm').addEventListener('submit', submitUrl);
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
    $('fileInput').addEventListener('change', (event) => void handleUpload(event.target.files[0]));
    $('dropzone').addEventListener('click', (event) => {
      if (!event.target.closest('label')) $('fileInput').click();
    });
    $('dropzone').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        $('fileInput').click();
      }
    });
    ['dragover', 'dragleave', 'drop'].forEach((name) => $('dropzone').addEventListener(name, (event) => {
      event.preventDefault();
      event.stopPropagation();
    }));
    $('dropzone').addEventListener('dragover', () => $('dropzone').classList.add('dragging'));
    $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
    $('dropzone').addEventListener('drop', (event) => {
      $('dropzone').classList.remove('dragging');
      void handleUpload(event.dataTransfer.files[0]);
    });
    $('retryBtn').addEventListener('click', retry);
    $('saveApiKeyBtn').addEventListener('click', () => {
      storageSet(API_KEY_STORAGE_KEY, $('apiKeyInput').value.trim());
      showAuthPrompt(false);
    });
    $('toggleHistoryBtn').addEventListener('click', () => {
      const visible = !$('historyList').classList.contains('collapsed');
      $('historyList').classList.toggle('collapsed', visible);
      $('toggleHistoryBtn').textContent = visible ? 'Hiện' : 'Thu gọn';
    });
    for (const id of ['sceneScopeFilter', 'typeFilter', 'modeFilter', 'qualityFilter']) {
      if ($(id)) $(id).addEventListener('change', renderFilteredAssets);
    }
  }

  function init() {
    bindEvents();
    setTab('url');
    void loadConfig().then(() => renderHistory());
    const lastJobId = readStoredJobId();
    if (lastJobId) {
      activeJobId = lastJobId;
      showSection('progress');
      void poll(lastJobId);
    }
  }

  window.addEventListener('DOMContentLoaded', init, { once: true });
})();
