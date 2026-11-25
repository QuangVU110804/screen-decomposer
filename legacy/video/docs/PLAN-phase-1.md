# Phase 1 — Detailed Plan: Ingestion (YouTube URL + File Upload)

> Parent doc: [PLAN.md](./PLAN.md). Prereq: [Phase 0](./PLAN-phase-0.md) done.
> Phase 1 overall difficulty: **Easy–Medium**. Upload/multipart handling is the only fiddly part; the download path already exists.
> Definition of done: **one logical entry point with two front doors** — after ingestion the job has a valid local `videoPath` + `duration` regardless of source, and the existing frames pipeline still completes from there.

**Current state (before this phase):**

| File | Status today |
|------|--------------|
| `src/routes/extractRoutes.js` | `normalizeYoutubeUrl()` inlined; `POST /extract` → `runPipeline(jobId,url)` which downloads then extracts all frames |
| `src/services/downloadService.js` | `downloadVideo(url, jobId, onProgress)` → `temp/videos/{jobId}.{ext}`, returns real path |
| `src/utils/videoInfo.js` | `getDuration(videoPath)` |
| `src/config.js` | after Phase 0: `UPLOAD_TMP_DIR`, `MAX_UPLOAD_MB`, duration guard, etc. exist |

**Design decisions locked for this phase:**

1. Ingestion logic lives in `src/services/ingestionService.js`; routes become thin (parse → createJob → kick pipeline → 202).
2. `runPipeline` is split: an **ingestion stage** (source-specific) followed by a shared **post-ingestion stage** `runAnalysis(jobId, videoPath, duration)`. Phase 1 keeps `runAnalysis` = existing all-frames extraction; Phase 2 swaps its guts. This makes the two sources converge cleanly.
3. Uploads land in `temp/videos/{jobId}.{ext}` — the same naming convention as yt-dlp output, so everything downstream is source-agnostic.
4. **Validation is by extension + ffprobe-ability, not MIME trust** (browser MIME is spoofable; ffprobe success is the real proof it's a video).

---

## Task 1.1 — Install `multer`

**Difficulty: Easy (~10 min)**

1. `npm install multer` (use current stable 2.x; API for `diskStorage` is the same as 1.x).
2. Confirm `node -e "require('multer');console.log('ok')"`.

Acceptance:
- [ ] `multer` in `package.json` dependencies.

---

## Task 1.2 — `ingestionService.resolveYoutube(input)`

**Difficulty: Easy (~20 min)**

Move `normalizeYoutubeUrl` out of `extractRoutes.js` verbatim into ingestionService, exported as `resolveYoutube(input)`.

```js
// rules to preserve:
//   youtube.com/embed/<11id>   -> https://www.youtube.com/watch?v=<11id>
//   raw 11-char [A-Za-z0-9_-]  -> watch?v=<id>
//   anything else              -> returned unchanged (assume valid watch/youtu.be url)
```

Also accept the current `youtu.be/<id>` form (add one regex; it's free and users paste it). Trim input first.

Acceptance:
- [ ] Table-test via `node -e` (or a tiny script in `src/utils/` run manually): all 4 input shapes → expected output; route no longer contains the regex.

---

## Task 1.3 — `ingestionService.guardDuration(videoPath)`

**Difficulty: Easy (~20 min)**

```js
async function guardDuration(videoPath) {
  const { getDuration } = require('../utils/videoInfo');
  const duration = await getDuration(videoPath);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Không đọc được thời lượng video (file hỏng / sai định dạng)');
  if (duration > config.MAX_VIDEO_DURATION_SEC)
    throw new Error(`Video dài ${Math.round(duration)}s, vượt giới hạn ${config.MAX_VIDEO_DURATION_SEC}s (MAX_VIDEO_DURATION_SEC)`);
  return duration;
}
```

This replaces the inline duration check currently inside `runPipeline`. Throws → route's `try/catch` marks job `failed`.

Acceptance:
- [ ] A local video longer than the limit (set `MAX_VIDEO_DURATION_SEC=2` temporarily + upload a 5s clip) → job `failed` with the duration message.

---

## Task 1.4 — `ingestionService.acceptUpload(jobId, multerFile)`

**Difficulty: Medium (~1–1.5 h)** — the core task of this phase.

Move the uploaded temp file into the videos dir with the standard name, returning `{ videoPath, duration }`.

```js
const ALLOWED_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi']);

async function acceptUpload(jobId, file) {
  // 1. basic presence check
  if (!file) throw new Error('Không nhận được file (đúng tên field là "file"?)');

  // 2. extension whitelist (lowercased), derived from originalname
  const ext = (path.extname(file.originalname || '').slice(1) || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext))
    throw new Error(`Định dạng không được hỗ trợ: .${ext || '?'} (cho phép: mp4, mov, mkv, webm, avi)`);

  // 3. hard size re-check (multer already enforced the limit, belt + suspenders)
  if (file.size > config.MAX_UPLOAD_MB * 1024 * 1024)
    throw new Error(`Vượt quá ${config.MAX_UPLOAD_MB}MB`);

  // 4. move temp/uploads/<random> -> temp/videos/<jobId>.<ext>
  const dest = path.join(config.VIDEO_DIR, `${jobId}.${ext}`);
  config.ensureDir(config.VIDEO_DIR);
  try { await fs.promises.rename(file.path, dest); }        // fast, same-volume
  catch (e) {
    if (e.code !== 'EXDEV') throw e;                         // cross-drive (Windows): fall back
    await fs.promises.copyFile(file.path, dest);
    await fs.promises.unlink(file.path);
  }

  // 5. prove it decodes: guardDuration -> also rejects non-video/renamed junk
  const duration = await guardDuration(dest);
  return { videoPath: dest, duration, originalFilename: file.originalname };
}
```

Notes:
- On Windows, `rename` fails with `EXDEV` when `temp/uploads` and `temp/videos` are on different volumes — the fallback matters even though they're normally the same tree.
- ffprobe check via `guardDuration` catches a `.txt` renamed to `.mp4`.
- Never trust `file.originalname` beyond echoing it back; it's stored on the job for display only, **not** used for the on-disk name.

Acceptance:
- [ ] Valid `sample.mp4` upload → file lands at `temp/videos/{jobId}.mp4`, `duration` correct.
- [ ] Oversized file (bump a small `MAX_UPLOAD_MB`) → 400, temp file not leaked in `temp/uploads` (see 1.7).
- [ ] `.txt` renamed `.mp4` → job `failed`, ffprobe error surfaces.

---

## Task 1.5 — Configure `multer` (disk storage, limits) as a route-level middleware

**Difficulty: Easy–Medium (~45 min)**

Create the shared uploader instance (put it in ingestionService or a small `src/middleware/upload.js`):

```js
const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => { config.ensureDir(config.UPLOAD_TMP_DIR); cb(null, config.UPLOAD_TMP_DIR); },
  filename:  (req, file, cb) => cb(null, `${randomUUID()}.part`),   // never attacker-controlled
});
const upload = multer({
  storage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});
```

- Random filename in `temp/uploads` until a job id exists; the real job id is minted inside the route (multer runs before our handler), and `acceptUpload` moves it into place.
- `files: 1` — one video per request.

Acceptance:
- [ ] Two files in one request → only first accepted / or 400 (`files:1`), server stable.
- [ ] Filename on disk is the UUID, not `file.originalname`.

---

## Task 1.6 — `POST /api/extract` refactor (URL path) to use ingestionService

**Difficulty: Easy (~30 min)**

Rewire the existing route, keeping behavior:

```js
router.post('/extract', (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Thiếu url' });
  const jobId = randomUUID();
  const normalized = ingestion.resolveYoutube(url);
  jobService.createJob(jobId, { sourceType: 'youtube', sourceUrl: normalized });
  pipeline.runUrl(jobId, normalized);            // background, do not await
  res.status(202).json({ jobId, status: 'pending' });
});
```

Where `runUrl` = existing pipeline, now delegating duration to `guardDuration` and splitting into the shared post-ingestion stage:

```js
async function runIngested(jobId, videoPath, duration) {
  jobService.updateJob(jobId, { videoPath, duration, status: 'extracting', progress: 50 });
  const { frameDir, frameCount } = await frameExtractionService.extractFrames(videoPath, jobId, ...);
  jobService.updateJob(jobId, { status: 'done', progress: 100, frameDir, frameCount });
}
async function runUrl(jobId, url) {
  try {
    updateJob(jobId, { status: 'downloading' });
    const videoPath = await downloadService.downloadVideo(url, jobId, pct => updateJob(jobId, {progress: pct*0.4|0}));
    const duration = await ingestion.guardDuration(videoPath);
    await runIngested(jobId, videoPath, duration);
  } catch (err) { jobService.updateJob(jobId, { status: 'failed', error: err.message }); }
}
```

Acceptance:
- [ ] Original curl from Phase 0 regression (`{url:"dQw4w9WgXcQ"}`) reaches `done`; `GET /api/jobs/:id` shows `sourceType:"youtube"`.

---

## Task 1.7 — Add `POST /api/extract/upload` route + pipeline

**Difficulty: Medium (~1–1.5 h)** — combine upload intake with the same post-ingestion stage, plus cleanup.

```js
router.post('/extract/upload', (req, res) => {
  // jobId minted here so multer's tmp file can be tracked for cleanup on failure
  upload.single('file')(req, res, (multerErr) => {
    if (multerErr) {
      // multer surfaced an error before our handler ran (e.g. LIMIT_FILE_SIZE)
      return res.status(400).json({ error: multerErr.code === 'LIMIT_FILE_SIZE'
        ? `File vượt quá ${config.MAX_UPLOAD_MB}MB`
        : `Lỗi upload: ${multerErr.message}` });
    }
    // Note: multer's File object property is "originalname" (no capital F, no "File" suffix) —
    // easy to typo as originalFilename/originalName; get it wrong and job.originalFilename is
    // always undefined.
    const jobId = randomUUID();
    const job = jobService.createJob(jobId, { sourceType: 'upload', originalFilename: req.file?.originalname });
    pipeline.runUpload(job.id, req.file);   // background, do not await
    res.status(202).json({ jobId: job.id, status: 'uploading' });
  });
});

async function runUpload(jobId, file) {
  try {
    jobService.updateJob(jobId, { status: 'uploading' });
    const { videoPath, duration } = await ingestion.acceptUpload(jobId, file);
    jobService.updateJob(jobId, { progress: 40 });
    await runIngested(jobId, videoPath, duration);
  } catch (err) {
    if (file?.path && fs.existsSync(file.path)) await fs.promises.unlink(file.path).catch(()=>{}); // clean tmp
    jobService.updateJob(jobId, { status: 'failed', error: err.message });
  }
}
```

Key rules:
- **Never** let the response block on processing — return 202 immediately after job creation.
- Multer tmp file: on the happy path it's renamed away; on failure paths (bad ext, ffprobe fail) delete it. A tiny `finally`-style cleanup or acceptUpload deleting its source suffices.
- `runIngested` is the **same shared stage** the URL path uses → guaranteed convergence.

Acceptance:
- [ ] `curl -F "file=@sample.mp4" http://localhost:3000/api/extract/upload` → `202 {jobId, status:"uploading"}` → poll to `done`, zip download works.
- [ ] No file in field `file` → 400 readable error, no job stuck in `pending` (mark failed or return before job create).
- [ ] After a failed bad-extension upload, `temp/uploads` is empty (no leftover `.part`).

---

## Task 1.8 — Static UI mount + placeholder page

**Difficulty: Easy (~15 min)**

In `src/server.js`:
```js
app.use(express.static(path.join(__dirname, 'public')));
```
Create `src/public/index.html` with a minimal placeholder ("asset extractor — UI in Phase 6"). No styling work.

Acceptance:
- [ ] `GET /` returns 200 with the placeholder.

---

## Task 1.9 — Regression + Phase 1 Definition of Done

**Difficulty: Easy (~30 min)**

Manual test matrix (both must reach `done` and produce a valid zip via the legacy frames pipeline):

| Input | Expect |
|-------|--------|
| `POST /api/extract {url: watch URL}` | `done`, sourceType youtube |
| `POST /api/extract {url: youtu.be/ID}` | resolves + `done` |
| `POST /api/extract {url: raw 11-char id}` | resolves + `done` |
| `POST /api/extract/upload` valid mp4 | `done`, sourceType upload |
| upload non-video / oversized | `failed`/400 + no temp leak |
| duration > limit (both sources) | `failed` with duration message |

Phase 1 Definition of Done:
- [ ] Tasks 1.1–1.8 acceptance all green.
- [ ] Routes contain **no** fs/path/ffprobe logic — it's all in ingestionService.
- [ ] Both sources converge on the identical `runIngested` stage (grep: only one place sets `status:'extracting'`).
- [ ] `git diff`: `downloadService.js`, `frameExtractionService.js`, `videoInfo.js` untouched.

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 1.1 | Install multer | Easy | 10 min |
| 1.2 | `resolveYoutube` (move normalize fn) | Easy | 20 min |
| 1.3 | `guardDuration` wrapper | Easy | 20 min |
| 1.4 | `acceptUpload` (move, validate, EXDEV, ffprobe) | **Medium** | 1–1.5 h |
| 1.5 | multer diskStorage config | Easy–Medium | 45 min |
| 1.6 | Refactor `POST /extract` to ingestion + shared stage | Easy | 30 min |
| 1.7 | Add `POST /extract/upload` + pipeline + cleanup | **Medium** | 1–1.5 h |
| 1.8 | Static mount + placeholder UI | Easy | 15 min |
| 1.9 | Regression + DoD | Easy | 30 min |
| | **Total** | **Easy–Medium** | **~5–6 h** |

**Hardest parts:** 1.4 (cross-volume move + proving a video is valid) and 1.7 (wiring multer's async error path into a clean 202-then-background job). Everything else is mechanical refactoring of code that already exists.

## Copy-paste agent prompt (Phase 1, all tasks)

```
Implement Phase 1 of docs/PLAN.md exactly as specified in docs/PLAN-phase-1.md.
Complete Phase 0 first (see docs/PLAN-phase-0.md) if not already done.
Work through tasks 1.1 → 1.9 in order; each task's "Acceptance" list must pass before the next.

Rules:
- All ingestion logic lives in src/services/ingestionService.js (resolveYoutube, acceptUpload, guardDuration). Routes stay thin: parse input, createJob, kick off background pipeline, return 202 immediately.
- Split the pipeline so BOTH sources converge on one shared post-ingestion stage (runIngested). In Phase 1 that stage still calls the existing extractFrames so nothing regresses.
- Uploads: multer diskStorage into temp/uploads with a random UUID .part filename, limits {fileSize: MAX_UPLOAD_MB, files:1}; then acceptUpload validates extension (mp4,mov,mkv,webm,avi), moves to temp/videos/<jobId>.<ext> (handle EXDEV cross-volume via copy+unlink), and validates via ffprobe (guardDuration). Delete the tmp file on every failure path.
- POST /api/extract/upload field name is "file"; return 202 {jobId,status:"uploading"}.
- Add express.static on src/public and a placeholder index.html.
- Do NOT change downloadService.js, frameExtractionService.js, or videoInfo.js.
- Run the Task 1.9 regression matrix (both sources reach 'done' + valid zip).
```
