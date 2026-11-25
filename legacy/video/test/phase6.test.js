const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'src', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('Phase 6 page skeleton exposes both input tabs and terminal sections hidden', () => {
  for (const id of ['tab-url', 'tab-upload', 'panel-url', 'panel-upload', 'urlInput', 'fileInput', 'dropzone', 'progressSection', 'resultSection', 'errorSection', 'retryBtn', 'authSection', 'apiKeyInput', 'saveApiKeyBtn', 'historySection', 'historyList', 'toggleHistoryBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /id="panel-upload" class="panel hidden"/);
  assert.match(html, /id="progressSection" class="status-section hidden"/);
  assert.match(html, /id="resultSection" class="result-section hidden"/);
  assert.match(html, /id="errorSection" class="error-section hidden"/);
  assert.doesNotMatch(html, /\son(?:click|change|submit|drop|dragover)\s*=/i);
  assert.match(html, /id="sceneScopeFilter"/);
});

test('Phase 6 client wires config, URL/upload endpoints, resume storage, retry intervals, history and auth', () => {
  assert.match(app, /fetch\('\/api\/config'\)/);
  assert.match(app, /fetch\('\/api\/extract'/);
  assert.match(app, /fetch\('\/api\/extract\/upload'/);
  assert.match(app, /lastJobId/);
  assert.match(app, /POLL_INTERVAL_MS = 1500/);
  assert.match(app, /RETRY_INTERVAL_MS = 3000/);
  assert.match(app, /setTimeout\(\(\) => poll\(jobId\), delay\)/);
  assert.match(app, /clearPollTimer\(\)/);
  assert.match(app, /response\.status === 404/);
  assert.match(app, /encodeURIComponent\(jobId\)/);
  for (const status of ['pending', 'downloading', 'uploading', 'sampling', 'filtering', 'analyzing', 'finalizing', 'done', 'failed']) {
    assert.match(app, new RegExp(`\\b${status}:`), `missing status label: ${status}`);
  }
  // Auth feature
  assert.match(app, /apiKey/);
  assert.match(app, /X-API-Key/);
  assert.match(app, /authHeaders\(\)/);
  assert.match(app, /authRequired/);
  assert.match(app, /saveApiKeyBtn/);
  // Job history feature
  assert.match(app, /fetch\('\/api\/jobs'\)/);
  assert.match(app, /historyList/);
  assert.match(app, /historySection/);
  assert.match(app, /toggleHistoryBtn/);
  assert.match(app, /formatDate\(/);
});

test('Phase 6 result rendering keeps untrusted model text out of HTML parsing', () => {
  assert.match(app, /textContent = String\(value \?\? ''\)/);
  assert.match(app, /asset\.label/);
  assert.match(app, /asset\.description/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.doesNotMatch(app, /eval\s*\(/);
  assert.match(app, /target = '_blank'/);
  assert.match(app, /setAttribute\('download'/);
  assert.match(app, /downloadAllBtn.*href|href = `\/api\/jobs/);
  assert.match(app, /editorReviewerId/);
  assert.match(app, /asset\.occurrences/);
  assert.match(app, /return response\.ok/);
});

test('Phase 6 stylesheet covers dark responsive layout, grid and animated progress', () => {
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fill, minmax\(220px, 1fr\)\)/);
  assert.match(css, /transition:\s*width 0\.3s/);
  assert.match(css, /\.dropzone\.dragging/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

class FakeClassList {
  constructor(value = '') {
    this.values = new Set(value.split(/\s+/).filter(Boolean));
  }

  toggle(name, force) {
    const shouldHave = force === undefined ? !this.values.has(name) : Boolean(force);
    if (shouldHave) this.values.add(name);
    else this.values.delete(name);
    return shouldHave;
  }

  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.listeners = {};
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.href = '';
    this.disabled = false;
    this.files = [];
  }

  addEventListener(name, handler) { this.listeners[name] = handler; }

  dispatch(name, event = {}) {
    return this.listeners[name]?.({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) { this.children = children; }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  querySelector(selector) {
    if (selector === '[role="progressbar"]') return this.progressBar;
    return null;
  }

  closest() { return null; }
  focus() {}
  click() {}
}

function createUiHarness() {
  const ids = [
    'progressSection', 'resultSection', 'errorSection', 'progressFill', 'progressPercent',
    'statusText', 'tab-url', 'tab-upload', 'panel-url', 'panel-upload', 'urlForm', 'urlInput',
    'submitUrl', 'dropzone', 'fileInput', 'uploadHint', 'selectedFile', 'assetCount',
    'downloadAllBtn', 'assetGrid', 'errorText', 'retryBtn',
    'authSection', 'apiKeyInput', 'saveApiKeyBtn',
    'historySection', 'historyList', 'toggleHistoryBtn',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement('div', id)]));
  elements.get('urlInput').value = '';
  elements.get('tab-url').dataset.tab = 'url';
  elements.get('tab-upload').dataset.tab = 'upload';
  elements.get('tab-url').classList.add('tab');
  elements.get('tab-upload').classList.add('tab');
  elements.get('progressSection').progressBar = new FakeElement('div');
  const tabs = [elements.get('tab-url'), elements.get('tab-upload')];
  const stored = new Map();
  const timers = [];
  const requests = [];
  let domReady;
  let jobResponse = {
    status: 'done',
    progress: 100,
    id: '00000000-0000-4000-8000-000000000001',
    assets: [{
      label: '<script>alert(1)</script>',
      description: 'mô tả "không được parse"',
      timecode: '00:02',
      url: '/assets/00000000-0000-4000-8000-000000000001/asset_001.png',
      thumbUrl: '/assets/00000000-0000-4000-8000-000000000001/asset_001_thumb.jpg',
    }],
  };
  const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
  const window = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    addEventListener: (name, handler) => { if (name === 'DOMContentLoaded') domReady = handler; },
    clearTimeout: (timer) => { const item = timers.find((entry) => entry.id === timer); if (item) item.cleared = true; },
    setTimeout: (handler, delay) => { const id = timers.length + 1; timers.push({ id, handler, delay, cleared: false }); return id; },
  };
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/config') return response({ maxUploadMb: 2, maxDurationSec: 120, allowedExtensions: ['mp4'] });
    if (url === '/api/extract') return response({ jobId: jobResponse.id, status: 'pending' }, 202);
    if (url.startsWith('/api/jobs/')) return response(jobResponse);
    return response({}, 404);
  };
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === '.tab' ? tabs : [],
    createElement: (tagName) => new FakeElement(tagName),
  };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(app, context, { filename: 'app.js' });
  return {
    elements,
    requests,
    timers,
    stored,
    fireReady: () => domReady(),
    setJob: (job) => { jobResponse = job; },
  };
}

test('Phase 6 UI runtime handles tabs, empty URL, safe asset text, terminal polling and retry', async () => {
  const ui = createUiHarness();
  ui.fireReady();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ui.elements.get('uploadHint').textContent, 'Tối đa 2MB, video dài tối đa 2 phút. Định dạng: .mp4.');
  ui.elements.get('tab-upload').dispatch('click');
  assert.equal(ui.elements.get('panel-url').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('panel-upload').classList.contains('hidden'), false);
  ui.elements.get('tab-url').dispatch('click');
  assert.equal(ui.elements.get('panel-url').classList.contains('hidden'), false);

  ui.elements.get('urlInput').value = '';
  ui.elements.get('urlForm').dispatch('submit');
  assert.equal(ui.elements.get('errorText').textContent, 'Nhập URL hoặc video ID trước.');
  assert.equal(ui.elements.get('errorSection').classList.contains('hidden'), false);
  assert.equal(ui.requests.filter((request) => request.url === '/api/extract').length, 0);

  ui.elements.get('urlInput').value = 'dQw4w9WgXcQ';
  await ui.elements.get('urlForm').dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.elements.get('resultSection').classList.contains('hidden'), false);
  assert.equal(ui.elements.get('assetGrid').children.length, 1);
  const card = ui.elements.get('assetGrid').children[0];
  assert.equal(card.children[1].children[0].textContent, '<script>alert(1)</script>');
  assert.equal(card.children[1].children[2].textContent, 'mô tả "không được parse"');
  assert.equal(ui.elements.get('downloadAllBtn').href, `/api/jobs/${ui.elements.get('downloadAllBtn').href.split('/').at(-2)}/download`);
  assert.equal(ui.stored.has('lastJobId'), false);

  ui.elements.get('retryBtn').dispatch('click');
  assert.equal(ui.elements.get('errorSection').classList.contains('hidden'), true);
  assert.equal(ui.elements.get('urlInput').value, '');
});
