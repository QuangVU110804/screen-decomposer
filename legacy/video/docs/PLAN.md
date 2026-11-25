# Video Visual-Asset Extractor — Implementation Plan

**Idea:** User provides a video (YouTube URL **or** uploaded file). The system analyzes the whole video, automatically detects distinct **visual assets** appearing inside it (inserted images, screenshots, charts, slides), extracts each as a separate clean image, and returns them with **timestamps + AI labels**.

```
Video → sample frames → find still segments → dedupe → confirm + label (Claude Vision) → extract clean image per asset

asset_001.png  "iPhone image"        00:23
asset_002.png  "MacBook image"       00:31
asset_003.png  "Website screenshot"  00:45
asset_004.png  "Chart"               01:02
```

This is **semantic** extraction, not frame-by-frame dumps: only distinct visual assets survive, each deduplicated and labeled.

**Chosen approach — Hybrid, single Node/Express stack:**

- **Cheap CV layer** (ffmpeg sampling + perceptual-hash dedupe + sharpness + `freezedetect`) narrows ~600 samples of a 10-min video down to ~20–40 candidates.
- **Claude Vision layer** confirms each candidate is a real inserted asset and produces its label — batched (5 images/request), so LLM cost stays tiny.
- No Python/OpenCV — Windows-friendly, one service, builds directly on the existing `yt-frame-extractor` codebase.

**Scope for v1:** full-screen (or near-full-screen) inserted assets only. Overlay/PiP detection is a possible later upgrade (see Phase 8).

---

## System prerequisites

- Node.js >= 18
- `yt-dlp` on PATH (existing)
- `ffmpeg` + `ffprobe` on PATH (existing)
- `ANTHROPIC_API_KEY` (from Phase 3)

## Target layout (end state)

```
src/
├─ server.js                  # express app + boot tasks
├─ config.js                  # all env keys + validation
├─ routes/
│  ├─ extractRoutes.js        # POST /api/extract (url | upload), GET /api/jobs/:id
│  └─ assetRoutes.js          # assets list, single asset image, zip download
├─ services/
│  ├─ jobService.js           # in-memory job store, canonical job shape
│  ├─ ingestionService.js     # normalize youtube url | accept upload, duration guard
│  ├─ downloadService.js      # existing yt-dlp download
│  ├─ candidateService.js     # ffmpeg sample + phash dedupe + freeze check -> candidates
│  ├─ visionService.js        # Claude Vision: confirm + label, batched
│  └─ assetExtractionService.js # pick best frame per asset, write final png + thumb
├─ utils/
│  ├─ videoInfo.js            # existing ffprobe duration
│  ├─ ffmpeg.js               # runFfmpeg/runFfprobe/formatTimecode/parseFreeze
│  ├─ hash.js                 # perceptual hash + hamming distance (via sharp)
│  └─ sharpness.js            # blur score (Laplacian-ish via sharp)
└─ public/                    # single-page web UI (Phase 6)

temp/
├─ videos/:jobId/
├─ candidates/:jobId/
└─ assets/:jobId/
```

## Canonical job model

```js
{
  id,
  status,             // pending | downloading | uploading | sampling | filtering | analyzing | done | failed
  sourceType,         // youtube | upload
  sourceUrl,          // youtube only
  originalFilename,   // upload only
  videoPath, duration,
  progress,           // 0..100
  candidates,         // [{framePath, timestamp, hash}] (debug aid)
  assets,             // [{index,label,description,timestamp,timecode,framePath,thumbPath,confidence}]
  error, createdAt, updatedAt
}
```

## `.env` keys (final set)

```
PORT=3000
ANTHROPIC_API_KEY=
YT_DLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe

MAX_VIDEO_DURATION_SEC=600
MAX_UPLOAD_MB=500
SAMPLE_FPS=1              # candidate sampling rate
MIN_ASSET_STILL_SEC=0.8   # segment must be still >= N sec to count as an inserted asset
FREEZE_NOISE_DB=-50dB     # freezedetect noise threshold (Phase 2) — less strict than ffmpeg's own -60dB default
FALLBACK_TO_SCENE_CUTS=true  # Phase 2: use scene-cut candidates when freezedetect finds too few spans
SCENE_THRESHOLD=0.3
MAX_SCENE_CANDIDATES=25
PHASH_HAMMING_THRESHOLD=10  # near-duplicate frames merge into one asset
MAX_CANDIDATES=60         # cost cap: max frames sent to Vision per video
VISION_MODEL=claude-sonnet-5
VISION_BATCH_SIZE=5       # images per Vision request
VISION_MAX_RETRIES=3
VISION_JPEG_QUALITY=70
VISION_MAX_EDGE_PX=1024
CLAUDE_TIMEOUT_MS=60000
ASSET_RETENTION_HOURS=24  # Phase 7: hourly sweep deletes job folders older than this
```

> This list is the running master copy. Each phase doc (`PLAN-phase-N.md`) is the authoritative
> source for exactly when/why a key was introduced — check there if a default looks stale.

---

# Phase 0 — Foundation: config, utils, job model

**Goal:** every later phase builds on one shared job shape, config surface, and helper utils. No new behavior yet.

**Required**
- npm add: `sharp`
- Env: all keys above added to `.env.example` (`.env` keys not present keep working with defaults)

**Files**
- Modify `src/config.js` — export all keys with parsed defaults; boot validation: fail fast if ffmpeg/ffprobe/yt-dlp missing from PATH (`spawnSync('ffmpeg','-version')`), warn if `ANTHROPIC_API_KEY` empty.
- Modify `src/services/jobService.js` — canonical job shape (additive; existing `/api/extract` flow must still work).
- Create `src/utils/ffmpeg.js` — `runFfmpeg(args)` / `runFfprobe(args)` promise wrappers over `child_process.spawn`, `formatTimecode(sec) → "MM:SS"`, `parseFreezeDetect(stderr) → [{start,end}]`, `parseSceneDetect(stderr) → [timestamps]`.
- Create `src/utils/hash.js` + `src/utils/sharpness.js` — stubs now, real impl in Phase 2.
- Modify `src/server.js` — `fs.mkdirSync(..., {recursive:true})` for `temp/videos|candidates|assets` on boot.

**Agent prompt**

```
Work in the existing Node/Express project at the repo root. Implement Phase 0 of docs/PLAN.md:

1. Rewrite src/config.js to read & validate ALL env keys listed in PLAN.md ".env keys" section (parseInt/parseFloat with the documented defaults). Add boot validation helpers.
2. Extend src/services/jobService.js to the canonical job model (status: pending|downloading|uploading|sampling|filtering|analyzing|done|failed; fields sourceType, sourceUrl, originalFilename, videoPath, duration, progress, candidates[], assets[], error, createdAt, updatedAt). Keep the existing createJob/updateJob/getJob API working.
3. Create src/utils/ffmpeg.js exporting runFfmpeg, runFfprobe, formatTimecode, parseFreezeDetect, parseSceneDetect.
4. Create stub src/utils/hash.js and src/utils/sharpness.js exporting placeholder functions.
5. Ensure temp/videos, temp/candidates, temp/assets are created on server boot.
6. npm install sharp. Update .env.example with all new keys and Vietnamese comments like the existing ones.

No detection logic yet. The existing POST /api/extract pipeline must keep working unchanged.
```

**Acceptance**
- [ ] `npm start` boots; missing API key only warns.
- [ ] Existing extract job flow (download → all-frames extract → zip) still passes end-to-end.
- [ ] `require('./src/config')` exposes every key with correct type.

---

# Phase 1 — Ingestion: YouTube URL + uploaded file

**Goal:** one entry point that accepts **either** source and always leaves a valid local `videoPath` + `duration` on the job.

**Required**
- npm add: `multer`
- Existing: `yt-dlp`, `ffmpeg`

**Files**
- Create `src/services/ingestionService.js`:
  - `resolveYoutube(urlOrId)` — move `normalizeYoutubeUrl` out of routes (full URL / embed URL / raw 11-char ID).
  - `acceptUpload(jobId, uploadedFile)` — validate extension/MIME whitelist (mp4, mov, mkv, webm, avi), move from multer temp to `temp/videos/:jobId/video.<ext>`.
  - `guardDuration(videoPath)` — ffprobe duration vs `MAX_VIDEO_DURATION_SEC`.
- Modify `src/routes/extractRoutes.js`:
  - `POST /api/extract` — JSON `{url}` (status → `downloading`, existing yt-dlp path).
  - `POST /api/extract/upload` — multipart `file` field (status → `uploading`, skips download entirely).
  - Both create a job and run the pipeline in background (202 + jobId).
- Modify `src/server.js` — `express.static('src/public')` so Phase 6 UI is served.

**Agent prompt**

```
Implement Phase 1 of docs/PLAN.md in this repo:

1. npm install multer.
2. Create src/services/ingestionService.js:
   - resolveYoutube(input): move the normalizeYoutubeUrl regex logic out of extractRoutes.js (accepts watch url, youtu.be, embed url, raw 11-char id).
   - acceptUpload(jobId, file): extension whitelist [mp4,mov,mkv,webm,avi]; move multer temp file to temp/videos/<jobId>/video.<ext>; return path. Reject with clear Error if size > MAX_UPLOAD_MB or bad extension.
   - guardDuration(videoPath): ffprobe duration; throw if > MAX_VIDEO_DURATION_SEC.
3. In src/routes/extractRoutes.js add POST /api/extract/upload using multer diskStorage to temp/uploads/, creating a job with sourceType:'upload', status 'uploading', then background pipeline: acceptUpload -> guardDuration -> (continue to Phase 2 steps later; for now reuse existing extractFrames so nothing regresses).
4. Refactor existing POST /api/extract to use resolveYoutube + guardDuration (keep behavior).
5. Serve src/public statically from server.js (create empty public/index.html placeholder).
```

**Acceptance**
- [ ] `POST /api/extract {url:"dQw4w9WgXcQ"}` still works (raw ID path).
- [ ] `curl -F "file=@clip.mp4" /api/extract/upload` returns 202, job reaches `done` via old frame pipeline (temporary).
- [ ] Oversize/invalid upload → 400 with readable error; job marked `failed`.
- [ ] Duration guard applies to **both** sources.

---

# Phase 2 — Candidate detection (cheap CV)

**Goal:** collapse a video into 20–40 candidate frames, each representing a *distinct still visual* lasting >= `MIN_ASSET_STILL_SEC`. No AI calls in this phase.

**Required**
- `ffmpeg` filters: `fps=1` sampling, `freezedetect=n=-60dB:d=<MIN>` (near-frozen segments), `select='gt(scene,0.3)'` (hard cuts)
- npm: `sharp` (installed in Phase 0)

**Algorithm (the heart of this phase)**

1. **Sample:** `ffmpeg -i video -vf fps=SAMPLE_FPS temp/candidates/:jobId/f_%05d.png` → the file at 0-based position `idx` in the sorted listing maps to `timestamp = idx/SAMPLE_FPS`.
2. **Still segments:** run `freezedetect` once over the video → `[{start,end}]` (with `d >= MIN_ASSET_STILL_SEC`). Keep only sampled frames whose timestamp falls inside a still segment.
3. **Dedupe:** for each kept frame compute a perceptual hash (dHash via `sharp`: resize to 9x8 grayscale → 64-bit string). Compare consecutive kept frames; if hamming distance <= `PHASH_HAMMING_THRESHOLD`, they're the **same asset** → group them.
4. **Best frame per group:** score sharpness (variance of Laplacian proxy: `sharp` grayscale → convolve 3x3 Laplacian kernel → variance); pick the highest-scoring frame of each group.
5. **Cap:** sort groups by first timestamp, slice to `MAX_CANDIDATES`.

Result: `candidates = [{framePath, timestamp, hash, sharpness}]` saved on the job.

**Files**
- Real implementations: `src/utils/hash.js` (`dhashFromFile`, `hamming`), `src/utils/sharpness.js` (`sharpnessFromFile`)
- Create `src/services/candidateService.js` → `findCandidates(job, videoPath, onProgress)`
- New pipeline status flow: `sampling` → `filtering`
- Wire into both pipelines in `extractRoutes.js` (replace the old "extract all frames" call in the *new* asset pipeline; keep old route behavior behind a query flag `?mode=frames` for comparison — or drop it once Phase 4 lands)

**Agent prompt**

```
Implement Phase 2 of docs/PLAN.md (candidate detection, NO LLM calls):

1. Implement src/utils/hash.js: dhashFromFile(path) using sharp — grayscale, resize 9x8 without maintainAspectRatio, compare adjacent pixels → 64-char hex hash; hamming(a,b).
2. Implement src/utils/sharpness.js: sharpnessFromFile(path) — grayscale, get raw pixels, compute Laplacian 3x3 variance (skip border pixels), return number. Higher = sharper.
3. Implement src/services/candidateService.js: findCandidates(job, videoPath, onProgress):
   a. ffmpeg sample at fps=SAMPLE_FPS into temp/candidates/<jobId>/ as f_%05d.png
   b. ffmpeg -vf freezedetect=n=-60dB:d=MIN_ASSET_STILL_SEC (capture stderr; parse with utils/ffmpeg.parseFreezeDetect into [{start,end}])
   c. keep frames whose timestamp ((idx-0.5)/SAMPLE_FPS) is inside a still span
   d. group consecutive kept frames by dhash hamming distance <= PHASH_HAMMING_THRESHOLD (merge groups whose distance stays under threshold)
   e. per group: pick sharpest frame as representative
   f. cap at MAX_CANDIDATES (by earliest timestamp), store on job.candidates, return them
   Report progress via onProgress(pct) across stages; set job status 'sampling' then 'filtering'.
4. Add a dry-run script or temporary GET /api/jobs/:id/candidates JSON so we can verify without Vision.
5. Unit-testable: hash.js/sharpness.js pure functions; export everything.
```

**Acceptance**
- [ ] A 10-min slideshow video yields 10–40 candidates (not hundreds), each a *different* image.
- [ ] Two identical images shown twice in the video produce **one** group (deduped by hash).
- [ ] A candidate's timestamp is within ±1s of where the asset appears.
- [ ] Phase runs with **zero** API calls; job.candidates visible via the debug endpoint.

---

# Phase 3 — Claude Vision: confirm + label

**Goal:** for each candidate group, ask Claude Vision: "Is this a distinct inserted visual asset (photo/screenshot/chart/slide), and what is it?" Keep a structured verdict + label.

**Required**
- npm add: `@anthropic-ai/sdk`
- Env: `ANTHROPIC_API_KEY`, `VISION_MODEL`, `VISION_BATCH_SIZE`, `CLAUDE_TIMEOUT_MS`

**Design**

- Send **batches of `VISION_BATCH_SIZE` images** per message. Each image is sent with its timestamp as text right before it ("Image 1 of this batch, timestamp 00:23").
- Prompt demands a JSON array. Use tool-forced structure (a single tool `report_assets` with an input schema `assets: [{ref, isAsset, label, description, confidence}]`) so parsing is exact — no prose to scrape.
- System prompt gist: *"You analyze frames sampled from a video. Identify frames showing an inserted visual asset — a photo, product image, screenshot, chart, diagram, or slide — that is NOT the normal talking-head / live footage of the video. For each, give a short human label (2–5 words, e.g. 'iPhone image', 'Revenue chart') and a one-sentence description. Frames of ordinary video content are not assets."*
- Temperature 0. Retries: exponential backoff on 429/5xx, max 3. One failed batch logs and continues (partial results acceptable).
- Response mapping: `ref` is the batch-local index → candidate's `timestamp` becomes the asset's `timestamp`.
- Merge Phase-2 groups *after* Vision: if two surviving assets have same-ish hash AND labels agree, keep the earlier one (safety net over Phase-2 dedupe).

**Files**
- Create `src/services/visionService.js` → `classifyCandidates(candidates)` returning `[{candidate, isAsset, label, description, confidence}]`
- Status flow adds `analyzing`; progress mapping: sampling 0–20%, filtering 20–35%, **Vision 35–90%** (per batch fraction), finalize 90–100%
- `config.js` already has the keys

**Agent prompt**

```
Implement Phase 3 of docs/PLAN.md (Claude Vision classification):

1. npm install @anthropic-ai/sdk.
2. Create src/services/visionService.js:
   - classifyCandidates(candidates) — chunk into VISION_BATCH_SIZE; for each batch build one messages.create({model: VISION_MODEL, ...}) with base64 PNG images interleaved with text markers "FRAME ts=MM:SS".
   - Force JSON via tool choice: tool report_assets { assets: [{ ref:int, isAsset:bool, label:string, description:string, confidence:number(0-1) }]} with tool_choice {type:'tool', name:'report_assets'} and temperature 0.
   - Retry 3x exponential backoff on rate-limit/server error; on final failure skip batch, log warning, keep partial results.
   - Map refs back to candidates; return array of {candidate, isAsset, label, description, confidence}. Filter isAsset===true.
3. In the pipeline (extractRoutes runPipeline for BOTH sources): after findCandidates set status 'analyzing', call visionService, store surviving labeled candidates on job (assets field partially filled: label/description/timestamp/confidence + framePath from candidate).
4. Progress: Vision stage maps 35→90% by batches done / total batches.
5. Add ANTHROPIC_API_KEY guard: if key missing at this stage, fail job with actionable message.
```

**Acceptance**
- [ ] A 30-candidate slideshow video ≈ 6 API calls (batch of 5).
- [ ] `job.assets` contains entries like `{label:"Website screenshot", timestamp:45.5, timecode:"00:45"}` for real inserts, and **no** entries for ordinary footage (talking head, screen recording of scrolling content stays out).
- [ ] Labels are 2–5 readable words, not "frame_23.png".
- [ ] One simulated bad batch (bad key mid-run or oversized image) → job still completes with other batches' results.

---

# Phase 4 — Asset extraction & finalize

**Goal:** turn surviving candidates into final deliverables: `asset_00N.png` + JPEG thumbnail + timecode, written into `temp/assets/:jobId/`.

**Files**
- Create `src/services/assetExtractionService.js` → `finalizeAssets(job)`
- `manifest.json` in each asset folder (all labels/timestamps) — also returned by Phase 5 API

**Design**

- The Phase-2 representative frame **is** the clean image (already the sharpest of its still window) — copy to `asset_00N.png` (N ordered by timestamp). No re-decoding needed for v1.
- `sharp`: resize 320px wide → `asset_00N_thumb.jpg` (quality 80) for the web grid.
- `timecode` via `formatTimecode(timestamp)`; set `job.status='done'`, progress 100.
- Asset numbering + manifest written atomically at the end so partial runs never leave half-labeled outputs.

**Agent prompt**

```
Implement Phase 4 of docs/PLAN.md:

1. Create src/services/assetExtractionService.js: finalizeAssets(job) — sort confirmed assets by timestamp; for i, copy candidate framePath to temp/assets/<jobId>/asset_%03d.png (1-indexed), generate 320px-wide JPEG thumbnail asset_%03d_thumb.jpg via sharp, fill framePath/thumbPath/index/timecode fields. Write manifest.json (all asset metadata, ISO times).
2. Call it at the end of the pipeline; set status 'done', progress 100.
3. Clean stale temp/assets/<jobId> at start of finalize (idempotent re-runs).
```

**Acceptance**
- [ ] `temp/assets/:jobId/` contains exactly `asset_001.png`, `asset_001_thumb.jpg`, … + `manifest.json`.
- [ ] Full-size PNG is pixel-identical to the chosen sharpest frame (no recompression artifacts beyond original decode).
- [ ] Re-running finalize on the same job doesn't duplicate numbering.

---

# Phase 5 — API endpoints

**Goal:** expose results + keep the two-input entry points tidy.

**Endpoints (final)**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/extract` | `{url}` → 202 `{jobId}` |
| POST | `/api/extract/upload` | multipart `file` → 202 `{jobId}` |
| GET | `/api/jobs/:id` | job + `assets[]` (labels/timestamps; paths hidden as `/assets/:id/...` URLs) |
| GET | `/assets/:id/asset_001.png` | serve a full-size asset image |
| GET | `/assets/:id/asset_001_thumb.jpg` | serve thumbnail |
| GET | `/api/jobs/:id/download` | zip of `assets/` + `manifest.json` |
| GET | `/api/jobs` | list jobs (id, status, sourceType, assetCount, createdAt) |

**Files**
- Create `src/routes/assetRoutes.js`; register in `server.js`
- `express.static('src/public')` already in Phase 1
- Sanitize filename params (regex `^asset_\d{3}(_thumb)?\.(png|jpg)$`) — never trust path segments

**Agent prompt**

```
Implement Phase 5 of docs/PLAN.md:
1. Create src/routes/assetRoutes.js: GET /assets/:jobId/:filename serving from temp/assets/<jobId> with strict filename regex + path traversal guard; GET /api/jobs/:id/download → zip of assets dir + manifest.json (reuse archiver like frames route did); GET /api/jobs listing summary.
2. GET /api/jobs/:id response must map framePath/thumbPath to public URLs (/assets/<id>/<file>), never absolute fs paths.
3. Wire routes in server.js; remove the old all-frames routes (frames/ and /jobs/:id/frames) OR keep behind ?legacy=1 — prefer removing, this project's purpose is now assets.
```

**Acceptance**
- [ ] `GET /api/jobs/:id` shows `assets[]` with public URLs, labels, timecodes.
- [ ] `GET /api/jobs/:id/download` zip opens with images + manifest.
- [ ] `..%2F` traversal attempts → 400.

---

# Phase 6 — Web UI

**Goal:** one page at `/` — paste URL **or** drop a file → live progress → asset grid with labels + timestamps → download.

**Required:** plain HTML/CSS/`fetch` — no framework, no build step (YAGNI).

**Files**
- `src/public/index.html`, `src/public/app.js`, `src/public/style.css`

**Behavior**
- Two input modes (tabs): URL text field | file drop zone (accepts video extensions, size limit shown from server config endpoint `GET /api/config` → `{maxUploadMb}`).
- After submit: poll `GET /api/jobs/:id` every 1.5s; render status + progress bar (status labels: Downloading / Sampling / Filtering / Analyzing / Done / Failed).
- Done: responsive grid of cards — thumbnail, **label** (big), timecode, description (small), click → open full image, per-card download, "Download all (zip)".
- Timecode click (later, optional): deep-link not required in v1.
- Failed: readable error text.

**Agent prompt**

```
Implement Phase 6 of docs/PLAN.md — dark, clean single page at src/public (index.html/app.js/style.css, no frameworks):
1. Tabs: "YouTube URL" input | "Upload file" dropzone (drag+click).
2. POST to /api/extract or /api/extract/upload, store jobId (also localStorage so refresh can resume), poll /api/jobs/:id every 1.5s.
3. Progress bar with current status text. Error state shows job.error.
4. Done: grid of asset cards from job.assets (thumb, label, timecode, description, links to full image and single download). "Download all" → /api/jobs/:id/download.
5. Simple, modern styling; mobile-friendly grid.
```

**Acceptance**
- [ ] End-to-end in browser: paste URL of a slideshow video → watch statuses change → grid of labeled assets appears.
- [ ] Drop an mp4 → same flow.
- [ ] Refresh mid-job → resumes polling the same job.

---

# Phase 7 — Hardening & cleanup

**Goal:** make it safe to run beyond "one demo".

**Required**
- **Temp cleanup:** hourly sweep deleting `temp/*/:jobId` older than `ASSET_RETENTION_HOURS` (jobs marked failed too); also delete video file once candidates extracted (space hog) — keep only if a "re-analyze" feature wants it back later.
- **Concurrency guard:** at most 1 active pipeline at a time (simple queue); reject new jobs with 429 when queue length > 5.
- **Vision cost guardrail:** log `imageBlocksSent` and estimated tokens per job; add `MAX_VISION_IMAGES` (=MAX_CANDIDATES already, but enforce in service).
- **Upload safety:** enforce `MAX_UPLOAD_MB` in multer; store originals with random names; never execute/serve uploads except through ffprobe/ffmpeg decode.
- **Errors:** every stage wrapped — job ends `failed` with human message, server never crashes on ffmpeg/Vision rejects.
- **README rewrite** of project root: new purpose, endpoints, env, flow diagram, ToS note kept.

**Agent prompt**

```
Implement Phase 7 of docs/PLAN.md:
1. src/services/cleanupService.js — setInterval hourly: delete temp/videos|candidates|assets subfolders older than ASSET_RETENTION_HOURS; after findCandidates succeeds, delete the job's video file.
2. Simple FIFO queue in extractRoutes: one pipeline at a time; /api/jobs returns queuePosition; >5 waiting → 429.
3. Wrap all pipeline stages; on any thrown error: status failed + message + keep partial assets.
4. Rewrite README.md for the visual-asset-extractor purpose (Vietnamese, same tone as current README).
```

**Acceptance**
- [ ] Disk usage stable over many jobs; failed jobs cleaned after retention window.
- [ ] 10 rapid submissions don't run 10 ffmpegs at once.
- [ ] Killing network mid-Vision leaves job `failed`, not stuck.

---

# Phase 8 — (Future) Overlays / PiP + video uploads on server restart

Out of v1 scope, parked here so the architecture can grow:

- **Overlay/PiP assets:** the still-region detector generalizes — instead of whole-frame `freezedetect`, compare consecutive sampled frames for *invariant sub-rectangles* (block-hash diff masks bounding box), crop the region, then Vision labels it. Needs a small real-CV step (numpy-style work in JS via sharp raw buffers, or move to Python service — approach B from brainstorm).
- **Persistent jobs:** swap `Map` for SQLite (`better-sqlite3`) so restarts don't lose history.
- **Non-still assets:** short animated inserts (B-roll clips) — segment by scene cuts and return a poster frame + time range.
- **Search:** embed labels with an embeddings model, let users query the asset library.

---

## Execution order & effort

| Phase | Depends on | Est. focus |
|-------|-----------|-----------|
| 0 | — | small |
| 1 | 0 | small |
| 2 | 0–1 | **core, medium** |
| 3 | 2 | medium |
| 4 | 2–3 | small |
| 5 | 4 | small |
| 6 | 5 | medium |
| 7 | 0–6 | medium |

Suggested run order for an agent: **0 → 1 → 2 → (verify candidates JSON!) → 3 → 4 → 5 → 6 → 7** — pause after Phase 2 and eyeball the candidate frames before spending anything on Vision.
