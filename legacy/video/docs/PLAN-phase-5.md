# Phase 5 — Detailed Plan: API Endpoints

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 4](./PLAN-phase-4.md) done — `temp/assets/:jobId/` is populated.
> **Difficulty: Easy–Medium.** Mostly routing; the one part that needs care is the file-serving
> path guard (never let a URL segment reach the filesystem unchecked).
> Definition of done: a client can create a job from either source, poll its status, list assets
> with public URLs + labels + timecodes, fetch any single asset image, and download everything as a zip.

**Final endpoint surface:**

| Method | Path | Purpose | Status codes |
|--------|------|---------|--------------|
| POST | `/api/extract` | `{url}` → create job | 202, 400 |
| POST | `/api/extract/upload` | multipart `file` → create job | 202, 400, 413 |
| GET | `/api/jobs` | list job summaries | 200 |
| GET | `/api/jobs/:id` | job detail incl. `assets[]` with public URLs | 200, 404 |
| GET | `/api/jobs/:id/assets` | assets only (thin payload for the UI grid) | 200, 404, 409 |
| GET | `/api/jobs/:id/download` | zip of assets + manifest | 200, 404, 409 |
| GET | `/assets/:jobId/:filename` | serve one asset image or thumb | 200, 400, 404 |
| GET | `/api/config` | `{maxUploadMb, maxDurationSec}` for the UI | 200 |
| GET | `/health` | existing liveness check | 200 |

`409 Conflict` is the right code for "job exists but isn't `done` yet" — clearer than the current `400`.

---

## Task 5.1 — Job serialization helper: strip filesystem paths, add public URLs

**Difficulty: Easy–Medium (~45 min)** — do this **first**; every other endpoint depends on it.

Absolute paths like `D:\yt-frame-extractor\temp\assets\<uuid>\asset_001.png` must never appear in a response. Create one serializer and use it everywhere:

```js
// src/utils/serialize.js
const path = require('path');

function toAssetUrl(jobId, filePath) {
  return filePath ? `/assets/${jobId}/${path.basename(filePath)}` : null;
}

function serializeAsset(jobId, a) {
  return {
    index: a.index,
    label: a.label,
    description: a.description,
    confidence: a.confidence,
    timestamp: a.timestamp,
    timecode: a.timecode,
    url: toAssetUrl(jobId, a.framePath),
    thumbUrl: toAssetUrl(jobId, a.thumbPath),
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl,
    originalFilename: job.originalFilename,
    duration: job.duration,
    detectionMode: job.detectionMode ?? null,   // from Phase 2 (freeze | scene_fallback)
    assetCount: job.assets?.length ?? 0,
    assets: (job.assets ?? []).map(a => serializeAsset(job.id, a)),
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function serializeJobSummary(job) {
  return { id: job.id, status: job.status, progress: job.progress, sourceType: job.sourceType,
           assetCount: job.assets?.length ?? 0, createdAt: job.createdAt };
}

module.exports = { serializeJob, serializeJobSummary, serializeAsset };
```

Deliberately **omitted** from every response: `videoPath`, `framePath`, `thumbPath`, `candidates[].path`.

Acceptance:
- [ ] `GET /api/jobs/:id` response contains **no** substring `temp\\` / `temp/` / `D:` — grep the JSON.
- [ ] `assets[].url` is `/assets/<jobId>/asset_001.png` and resolves (Task 5.2).
- [ ] A job with no assets serializes to `assets: []`, `assetCount: 0` — not `null`.

---

## Task 5.2 — `GET /assets/:jobId/:filename` with a strict path guard

**Difficulty: Medium (~1 h)** — the only security-sensitive code in this phase.

Do **not** use `express.static(ASSET_DIR)` here. A handler with an explicit allowlist regex is clearer about intent and lets us 400 on malformed names:

```js
// src/routes/assetRoutes.js
const ASSET_FILE_RE = /^asset_\d{3}(_thumb)?\.(png|jpg)$/;
// Actual UUID shape (8-4-4-4-12 hex), not just "36 chars of hex/hyphen" — the looser
// version would accept e.g. 36 repeated "a" characters, which isn't a real job id.
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/assets/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  if (!JOB_ID_RE.test(jobId) || !ASSET_FILE_RE.test(filename)) {
    return res.status(400).json({ error: 'Tên file hoặc jobId không hợp lệ' });
  }
  const dir = path.resolve(config.ASSET_DIR, jobId);
  const filePath = path.resolve(dir, filename);
  // defense in depth: resolved path must stay inside ASSET_DIR
  if (!filePath.startsWith(path.resolve(config.ASSET_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy file' });
  res.sendFile(filePath, { maxAge: '1h' });
});
```

Why both checks: the regex already makes traversal impossible, but the `path.resolve` + `startsWith` check is the invariant that survives someone later loosening the regex. Keep both.

Acceptance:
- [ ] `/assets/<validJobId>/asset_001.png` → 200 with `Content-Type: image/png`.
- [ ] `/assets/<validJobId>/asset_001_thumb.jpg` → 200 `image/jpeg`.
- [ ] `/assets/<validJobId>/../../../package.json` → 400 (also test URL-encoded `%2e%2e%2f`).
- [ ] `/assets/not-a-uuid/asset_001.png` → 400.
- [ ] `/assets/<validJobId>/manifest.json` → 400 (not in the allowlist — served via the zip or a dedicated route only, deliberately).
- [ ] Nonexistent but well-formed name → 404 JSON, not an HTML error page.

---

## Task 5.3 — `GET /api/jobs/:id` and `GET /api/jobs/:id/assets`

**Difficulty: Easy (~30 min)**

```js
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  res.json(serializeJob(job));
});

router.get('/jobs/:id/assets', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'Job chưa xong', status: job.status, progress: job.progress });
  }
  res.json({ jobId: job.id, count: job.assets.length, assets: job.assets.map(a => serializeAsset(job.id, a)) });
});
```

Note: `GET /api/jobs/:id` works at **every** status (that's how the UI polls progress) — only the assets/download routes require `done`.

Acceptance:
- [ ] Polling `/api/jobs/:id` mid-run returns 200 with the current `status`/`progress` (never 409).
- [ ] `/api/jobs/:id/assets` mid-run → 409 including current status+progress (so a client can back off intelligently).
- [ ] Unknown id → 404 on both.

---

## Task 5.4 — `GET /api/jobs/:id/download` (zip of assets + manifest)

**Difficulty: Easy (~30 min)** — adapt the existing `archiver` code from the old frames route.

```js
router.get('/jobs/:id/download', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job chưa xong', status: job.status });

  const dir = path.join(config.ASSET_DIR, String(job.id));
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Không còn file (có thể đã bị dọn)' });

  res.attachment(`${job.id}-assets.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('zip warning:', err.message));
  archive.on('error', (err) => { console.error('zip error:', err); res.destroy(err); });
  archive.pipe(res);
  archive.directory(dir, false);   // includes manifest.json + all pngs/thumbs
  archive.finalize();
});
```

Two fixes over the old route: `res.destroy(err)` instead of `res.status(500)` (headers are already sent once piping starts, so `status()` silently does nothing), and a 404 when the folder was cleaned by Phase 7's retention sweep.

Acceptance:
- [ ] Zip opens; contains `asset_001.png`, `asset_001_thumb.jpg`, ..., `manifest.json` at the archive root (no nested folder).
- [ ] Deleting `temp/assets/<id>` manually then hitting download → 404 JSON with the "đã bị dọn" message, not a 0-byte zip.
- [ ] Aborting the download mid-stream (curl `--max-time 0.1`) doesn't crash the server.

---

## Task 5.5 — `GET /api/jobs` and `GET /api/config`

**Difficulty: Easy (~20 min)**

```js
router.get('/jobs', (req, res) => {
  res.json({ jobs: listJobs().map(serializeJobSummary) });   // listJobs() added in Phase 0
});

router.get('/config', (req, res) => {
  res.json({
    maxUploadMb: config.MAX_UPLOAD_MB,
    maxDurationSec: config.MAX_VIDEO_DURATION_SEC,
    allowedExtensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'],
  });
});
```

`/api/config` exists so the Phase 6 UI shows the real limits instead of hardcoding them. Return **only** these three keys — never dump `config` (it holds `ANTHROPIC_API_KEY`).

Acceptance:
- [ ] `/api/config` response has exactly 3 keys, no secrets. Grep for `sk-ant` in the response → nothing.
- [ ] `/api/jobs` sorted newest-first, each entry has `assetCount`.

---

## Task 5.6 — Remove the legacy all-frames routes

**Difficulty: Easy (~30 min)**

The project's purpose is now assets, and keeping two parallel output paths doubles the surface Phase 7 has to clean up. Delete rather than deprecate:

1. Remove `GET /api/jobs/:id/frames` and the old `frameDir`/`frameCount` fields from responses (keep them on the job object if `frameExtractionService` is still referenced anywhere; otherwise remove those too).
2. Remove `app.use('/frames', express.static(FRAME_DIR))` from `server.js`.
3. `src/services/frameExtractionService.js` is now unused — delete the file, or keep it with a header comment `// unused since Phase 5 (asset pipeline replaced all-frames extraction)`. Prefer deleting; `git` remembers it.
4. Remove `FRAME_DIR` from config + boot `ensureDir` list, and `temp/frames` from `.gitignore` if listed separately.
5. Update the root `README.md` API section (fuller rewrite happens in Phase 7).

Acceptance:
- [ ] `grep -rn "frames" src/` returns no route/static references (comments are fine).
- [ ] Server boots without creating `temp/frames`.
- [ ] `GET /api/jobs/:id/frames` → 404 (the generic Express 404, acceptable) — and the new `/assets` route is what the docs point at.

---

## Task 5.7 — Register routes + Phase 5 Definition of Done

**Difficulty: Easy (~30 min)**

`src/server.js`:

```js
app.use('/api', extractRoutes);   // POST /api/extract, /api/extract/upload, GET /api/jobs...
app.use('/', assetRoutes);        // GET /assets/:jobId/:filename  (mounted at root by design)
```

Careful with mount points: if `assetRoutes` also defines `/api/jobs/:id/assets`, mount it under `/api` instead and keep the image-serving route in its own small router mounted at `/`. Pick one arrangement and document it in a comment at the top of each router file — mount-point confusion is the most common source of "my route 404s" in Express.

End-to-end acceptance matrix (run all six against a real job):

| Step | Expect |
|------|--------|
| `POST /api/extract {url}` | 202 + jobId |
| `GET /api/jobs/:id` (mid-run) | 200, status advancing, no fs paths |
| `GET /api/jobs/:id/assets` (mid-run) | 409 + status/progress |
| `GET /api/jobs/:id` (done) | assets[] with labels, timecodes, urls |
| `GET /assets/:id/asset_001.png` | 200 image |
| `GET /api/jobs/:id/download` | valid zip w/ manifest |

Phase 5 Definition of Done:
- [ ] Tasks 5.1–5.6 acceptance all green + the matrix above passes for **both** a URL job and an upload job.
- [ ] No response anywhere leaks an absolute path or a config secret.
- [ ] Traversal attempts (`../`, `%2e%2e%2f`, absolute `C:\`) all → 400.
- [ ] Legacy frames surface fully removed.

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 5.1 | Serializers (strip paths → public URLs) | Easy–Medium | 45 min |
| **5.2** | **Asset file serving + path traversal guard** | **Medium** | 1 h |
| 5.3 | Job detail + assets endpoints (409 semantics) | Easy | 30 min |
| 5.4 | Zip download (archiver, stream-error handling) | Easy | 30 min |
| 5.5 | Job list + `/api/config` | Easy | 20 min |
| 5.6 | Remove legacy all-frames routes | Easy | 30 min |
| 5.7 | Route registration + E2E matrix | Easy | 30 min |
| | **Total** | **Easy–Medium** | **~4 h** |

## Copy-paste agent prompt (Phase 5, all tasks)

```
Implement Phase 5 of docs/PLAN.md exactly as specified in docs/PLAN-phase-5.md.
Phase 4 is complete: temp/assets/<jobId>/ holds asset_00N.png, asset_00N_thumb.jpg, manifest.json,
and job.assets[] carries index/label/description/confidence/timestamp/timecode/framePath/thumbPath.

1. Create src/utils/serialize.js with serializeJob, serializeJobSummary, serializeAsset.
   Responses must NEVER include videoPath, framePath, thumbPath, or candidate paths — convert to
   /assets/<jobId>/<basename> URLs instead.
2. Create src/routes/assetRoutes.js:
   - GET /assets/:jobId/:filename — allowlist regex ^asset_\d{3}(_thumb)?\.(png|jpg)$ plus a
     uuid check on jobId, plus a path.resolve+startsWith containment check inside ASSET_DIR.
     400 on malformed, 404 on missing. manifest.json is deliberately NOT servable here.
   - GET /api/jobs/:id/assets — 409 (with status+progress) unless job.status === 'done'.
   - GET /api/jobs/:id/download — archiver zip of temp/assets/<jobId> (flat, includes
     manifest.json); 404 if the folder was already cleaned; on stream error use res.destroy(err),
     not res.status(500).
   - GET /api/jobs (summaries, newest first) and GET /api/config (only maxUploadMb,
     maxDurationSec, allowedExtensions — never leak the API key).
3. Update GET /api/jobs/:id to return serializeJob(job) and to work at EVERY status (the UI polls it).
4. Remove the legacy all-frames surface: GET /api/jobs/:id/frames, app.use('/frames', ...),
   FRAME_DIR from config/boot, and delete src/services/frameExtractionService.js.
5. Register routers in server.js with clear mount-point comments; run the end-to-end matrix in
   task 5.7 for both a YouTube job and an upload job and report results.

Verify traversal attempts (../, %2e%2e%2f, absolute paths) all return 400.
```
