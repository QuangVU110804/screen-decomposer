# Phase 6 — Detailed Plan: Web UI

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 5](./PLAN-phase-5.md) done — API surface is final.
> **Difficulty: Medium.** No framework, no build step (YAGNI) — but polling, drag-and-drop,
> resumable state, and a responsive grid take real frontend attention even in plain JS.
> Definition of done: open `/` in a browser, submit a URL **or** drop a file, watch progress
> update live, land on a grid of labeled asset cards, download individually or as a zip.

**Files (all new, plain HTML/CSS/JS, no bundler):**

```
src/public/
├─ index.html
├─ style.css
└─ app.js
```

`src/server.js` already serves this statically from Phase 1 (Task 1.8) — just replace the placeholder.

---

## Task 6.1 — Page skeleton + tabs (URL vs Upload)

**Difficulty: Easy (~45 min)**

`index.html` structure:

```html
<main>
  <h1>Video Visual-Asset Extractor</h1>
  <div class="tabs">
    <button class="tab active" data-tab="url">YouTube URL</button>
    <button class="tab" data-tab="upload">Upload file</button>
  </div>

  <section id="panel-url" class="panel">
    <input id="urlInput" type="text" placeholder="https://youtube.com/watch?v=... hoặc video ID" />
    <button id="submitUrl">Bắt đầu</button>
  </section>

  <section id="panel-upload" class="panel hidden">
    <div id="dropzone" class="dropzone">
      Kéo thả file video vào đây, hoặc <label for="fileInput" class="link">chọn file</label>
      <input id="fileInput" type="file" accept="video/*" hidden />
    </div>
    <p class="hint" id="uploadHint"></p>
  </section>

  <section id="progressSection" class="hidden">
    <div class="progress-bar"><div id="progressFill"></div></div>
    <p id="statusText"></p>
  </section>

  <section id="resultSection" class="hidden">
    <div class="result-header">
      <span id="assetCount"></span>
      <a id="downloadAllBtn" class="btn">Download all (zip)</a>
    </div>
    <div id="assetGrid" class="asset-grid"></div>
  </section>

  <section id="errorSection" class="hidden">
    <p id="errorText" class="error"></p>
    <button id="retryBtn">Thử lại</button>
  </section>
</main>
```

Tab switching is pure CSS-class toggling in `app.js` (`.hidden` class), no routing needed.

Acceptance:
- [ ] Clicking each tab shows only its panel; the other three sections (`progress`/`result`/`error`) start hidden.
- [ ] Page has no console errors on load with an empty API (server just booted, no jobs yet).

---

## Task 6.2 — Fetch `/api/config` on load; wire the URL submit path

**Difficulty: Easy (~30 min)**

```js
// app.js
let cfg = { maxUploadMb: 500, maxDurationSec: 600 };

async function loadConfig() {
  try {
    cfg = await (await fetch('/api/config')).json();
    document.getElementById('uploadHint').textContent =
      `Tối đa ${cfg.maxUploadMb}MB, video dài tối đa ${Math.round(cfg.maxDurationSec/60)} phút.`;
  } catch { /* fall back to defaults silently — non-critical */ }
}

document.getElementById('submitUrl').addEventListener('click', async () => {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return showError('Nhập URL hoặc video ID trước.');
  try {
    const res = await fetch('/api/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Lỗi không xác định');
    startJob(data.jobId);
  } catch (e) { showError('Không kết nối được server: ' + e.message); }
});
```

Acceptance:
- [ ] Submitting an empty URL shows the inline error without hitting the network.
- [ ] Submitting a valid raw video ID starts a job (progress section appears, `startJob` called).
- [ ] A server error response (400) surfaces its `error` message verbatim in the error section, not a generic "failed".

---

## Task 6.3 — Drag-and-drop + click-to-browse upload path

**Difficulty: Medium (~1 h)**

```js
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

['dragover', 'dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }));

dropzone.addEventListener('dragover', () => dropzone.classList.add('dragging'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  dropzone.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) handleUpload(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleUpload(file);
});

async function handleUpload(file) {
  if (file.size > cfg.maxUploadMb * 1024 * 1024) {
    return showError(`File vượt quá ${cfg.maxUploadMb}MB`);
  }
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/api/extract/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Lỗi upload');
    startJob(data.jobId);
  } catch (e) { showError('Không kết nối được server: ' + e.message); }
}
```

Rules:
- **Client-side size check is a UX nicety, not the security boundary** — the server (multer `limits`) is the real guard from Phase 1. Don't skip server validation because the client checks too.
- `e.preventDefault()` on `dragover` is required or the browser opens the file directly instead of firing `drop`.
- No progress bar for the upload transfer itself in v1 (only pipeline progress after upload completes) — acceptable for files under the 500MB default; note as a known limitation, not a bug to fix now.

Acceptance:
- [ ] Dragging a file over the dropzone shows a visual "dragging" state (border/background change).
- [ ] Dropping a non-video file still uploads (client doesn't gate by extension — server does) and surfaces the server's rejection message correctly.
- [ ] Dropping a file over `maxUploadMb` never reaches the network (client pre-check fires).
- [ ] Clicking the "chọn file" label opens the native file picker.

---

## Task 6.4 — Job polling with resumable state (localStorage)

**Difficulty: Medium (~1 h)**

```js
const STATUS_LABELS = {
  pending: 'Đang chờ...', downloading: 'Đang tải video...', uploading: 'Đang nhận file...',
  sampling: 'Đang lấy mẫu frame...', filtering: 'Đang lọc frame tĩnh...',
  analyzing: 'Đang phân tích bằng AI...', finalizing: 'Đang hoàn tất...',
  done: 'Hoàn tất', failed: 'Lỗi',
};

let pollTimer = null;

function startJob(jobId) {
  localStorage.setItem('lastJobId', jobId);
  showSection('progress');
  poll(jobId);
}

async function poll(jobId) {
  clearTimeout(pollTimer);
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (res.status === 404) { localStorage.removeItem('lastJobId'); return showError('Job không tồn tại (có thể server đã restart).'); }
    const job = await res.json();
    renderProgress(job);
    if (job.status === 'done') return renderResult(job);
    if (job.status === 'failed') return showError(job.error || 'Xử lý thất bại');
    pollTimer = setTimeout(() => poll(jobId), 1500);
  } catch (e) {
    // transient network hiccup — retry rather than giving up immediately
    pollTimer = setTimeout(() => poll(jobId), 3000);
  }
}

function renderProgress(job) {
  document.getElementById('progressFill').style.width = `${job.progress}%`;
  document.getElementById('statusText').textContent =
    `${STATUS_LABELS[job.status] || job.status} (${job.progress}%)`;
}

// resume on page load if a job was in flight
window.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  const last = localStorage.getItem('lastJobId');
  if (last) { showSection('progress'); poll(last); }
});
```

Acceptance:
- [ ] Refreshing the browser mid-job resumes polling the same job (no need to resubmit).
- [ ] After a job reaches `done` or `failed`, refreshing does **not** re-poll a finished job forever — `renderResult`/`showError` are terminal, but verify a stray `setTimeout` isn't still queued (call `clearTimeout` before every fetch, as above).
- [ ] A transient fetch failure (kill server for 2s, bring back up) doesn't permanently break polling — retries at 3s and recovers.
- [ ] Manually corrupt `localStorage.lastJobId` to a random string → clean 404 handling, not a stuck spinner.

---

## Task 6.5 — Asset grid rendering

**Difficulty: Medium (~1 h)**

```js
function renderResult(job) {
  clearTimeout(pollTimer);
  showSection('result');
  document.getElementById('assetCount').textContent = `${job.assets.length} asset(s) tìm thấy`;
  document.getElementById('downloadAllBtn').href = `/api/jobs/${job.id}/download`;

  const grid = document.getElementById('assetGrid');
  grid.innerHTML = '';
  if (job.assets.length === 0) {
    grid.innerHTML = '<p class="empty">Không phát hiện visual asset nào trong video này.</p>';
    return;
  }
  job.assets.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.innerHTML = `
      <a href="${a.url}" target="_blank" rel="noopener"><img src="${a.thumbUrl}" alt="${escapeHtml(a.label)}" loading="lazy"></a>
      <div class="asset-meta">
        <strong>${escapeHtml(a.label)}</strong>
        <span class="timecode">${a.timecode}</span>
        <p class="desc">${escapeHtml(a.description)}</p>
        <a class="btn-small" href="${a.url}" download>Download</a>
      </div>`;
    grid.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
```

**Why `escapeHtml` matters:** `label`/`description` come from an LLM response — untrusted text rendered via `innerHTML`. Without escaping, a crafted label like `<img src=x onerror=alert(1)>` (however unlikely from Claude, but the candidate label is still external content by trust-boundary rules) executes as HTML. Always escape.

Acceptance:
- [ ] Grid renders one card per asset, thumbnail loads, label/timecode/description visible.
- [ ] Clicking a thumbnail opens the full-size image in a new tab.
- [ ] Per-card "Download" downloads just that image (`download` attribute, not a new tab).
- [ ] "Download all (zip)" triggers the zip endpoint.
- [ ] Zero-asset job shows the empty-state message, not a blank grid.
- [ ] A label containing `<script>` or `"` renders as literal text, not executed/broken markup (paste-test via a temporary mock response).

---

## Task 6.6 — Error section + retry

**Difficulty: Easy (~20 min)**

```js
function showSection(name) {
  ['progress', 'result', 'error'].forEach(s =>
    document.getElementById(`${s}Section`).classList.toggle('hidden', s !== name));
}
function showError(msg) {
  clearTimeout(pollTimer);
  showSection('error');
  document.getElementById('errorText').textContent = msg;
}
document.getElementById('retryBtn').addEventListener('click', () => {
  localStorage.removeItem('lastJobId');
  showSection(null);
  document.getElementById('urlInput').value = '';
});
```

Acceptance:
- [ ] Any `showError` call clears the polling timer (no zombie poll racing the error state).
- [ ] "Thử lại" clears stored job id and returns to the input tabs cleanly.

---

## Task 6.7 — Styling pass

**Difficulty: Easy–Medium (~1–1.5 h)** — purely visual, no logic risk, but takes real time to look decent.

Minimum bar for `style.css`: dark background, centered `max-width` container, visible tab active-state, animated progress-bar fill (`transition: width 0.3s`), `.asset-grid` as `display:grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr))`, cards with a subtle border/shadow, mobile-friendly (test at 375px width — grid should collapse to 1-2 columns via `auto-fill`, no extra media query needed).

Acceptance:
- [ ] Resizing the browser to a phone width doesn't overflow horizontally.
- [ ] Progress bar visibly animates rather than jumping.
- [ ] Dropzone has a clear hover/dragging visual state (border color change is enough).

---

## Task 6.8 — Full manual browser walkthrough + Phase 6 Definition of Done

**Difficulty: Medium (~1 h)** — real browser testing, not just code review.

Walkthrough script:
1. Open `/` fresh (clear localStorage first). Submit a known-good YouTube URL. Watch every status label change in order. Land on the asset grid.
2. Reload the page mid-run (during `analyzing`) — confirm it resumes instead of resetting.
3. Switch to Upload tab, drop an `.mp4` — confirm the same status progression and grid.
4. Try an oversized file, a non-video file, and an empty URL submit — confirm each error path reads clearly in Vietnamese and the UI recovers with "Thử lại".
5. On a finished job, click a thumbnail (opens full image), click a card's Download (downloads one file), click "Download all" (downloads zip).
6. Resize to a narrow viewport at each stage.

Phase 6 Definition of Done:
- [ ] All 6 walkthrough steps pass without console errors.
- [ ] Tasks 6.1–6.7 acceptance all green.
- [ ] No inline `onclick=` handlers, no `eval`, no unescaped LLM text in the DOM (Task 6.5's XSS check).
- [ ] Works with server started fresh (`npm start`), no dev-only assumptions (no CORS needed since it's same-origin).

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 6.1 | Page skeleton + tabs | Easy | 45 min |
| 6.2 | Config fetch + URL submit | Easy | 30 min |
| 6.3 | Drag-and-drop + upload submit | Medium | 1 h |
| 6.4 | Polling + resumable state (localStorage) | Medium | 1 h |
| 6.5 | Asset grid rendering (+ XSS escaping) | Medium | 1 h |
| 6.6 | Error section + retry | Easy | 20 min |
| 6.7 | Styling pass | Easy–Medium | 1–1.5 h |
| 6.8 | Manual browser walkthrough + DoD | Medium | 1 h |
| | **Total** | **Medium** | **~6.5–7.5 h** |

**Two things easy to get wrong:** forgetting `escapeHtml` on LLM-sourced label/description text (6.5), and leaving a stray `setTimeout` polling loop running after a job finishes or errors (6.4/6.6) — always `clearTimeout` before starting a new fetch or transitioning to a terminal state.

## Copy-paste agent prompt (Phase 6, all tasks)

```
Implement Phase 6 of docs/PLAN.md exactly as specified in docs/PLAN-phase-6.md.
Phase 5's API is final: POST /api/extract {url}, POST /api/extract/upload (multipart field
"file"), GET /api/jobs/:id (works at every status), GET /api/jobs/:id/download, GET /api/config.

Build a plain HTML/CSS/JS single page (no framework, no build step) at src/public/
(index.html, style.css, app.js) replacing the Phase 1 placeholder:

1. Two tabs: YouTube URL input, and a drag-and-drop + click-to-browse upload zone. Fetch
   /api/config on load to show real size/duration limits.
2. Submitting either path POSTs to the right endpoint, stores the returned jobId in
   localStorage, and starts polling GET /api/jobs/:id every 1.5s (retry at 3s on transient
   fetch failure; always clearTimeout before scheduling the next poll or entering a terminal
   state so no zombie polling loop survives).
3. On page load, resume polling from localStorage if a job was in flight; handle a 404
   (e.g. server restarted) by clearing the stored id and showing a clear message.
4. Render a progress bar + Vietnamese status label mapped from job.status (pending/
   downloading/uploading/sampling/filtering/analyzing/finalizing/done/failed).
5. On done, render a responsive grid of asset cards (thumbnail, label, timecode, description,
   per-card download link) plus a "Download all (zip)" link to the download endpoint. Zero
   assets shows a clear empty state. CRITICAL: escape all LLM-sourced text (label,
   description) before inserting into innerHTML — labels are untrusted content.
6. On failed, show job.error and a "Thử lại" button that resets to the input tabs.
7. Style: dark theme, centered container, CSS grid for the asset cards
   (repeat(auto-fill,minmax(220px,1fr))), mobile-friendly without extra breakpoints,
   animated progress bar width transition.

After building, manually walk through: fresh URL submission end-to-end, mid-run page reload
(must resume), upload path end-to-end, three error cases (oversized file, non-video file,
empty URL), and viewport resize to ~375px. Report the walkthrough results.
```
