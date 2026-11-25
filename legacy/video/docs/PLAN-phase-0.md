# Phase 0 — Detailed Plan: Foundation, Config & Job Model

> Parent doc: [PLAN.md](./PLAN.md). Phase 0 overall difficulty: **Easy**.
> No new behavior, no detection logic — only shared foundations Phases 1–7 build on.
> Existing `/api/extract` flow (download → extract all frames → zip) must keep working end-to-end.

**Current state (what exists before this phase):**

| File | Status today |
|------|--------------|
| `src/config.js` | 6 keys: dirs, binary paths, `MAX_VIDEO_DURATION_SEC` |
| `src/services/jobService.js` | In-memory `Map`; job = `{id,status,progress,error,sourceUrl,videoPath,frameDir,frameCount,createdAt}` |
| `src/utils/videoInfo.js` | `getDuration(videoPath)` via ffprobe — **works, don't touch** |
| `src/services/downloadService.js` | yt-dlp → saves `temp/videos/{jobId}.{ext}` (flat file) — **don't touch** |
| `src/services/frameExtractionService.js` | all-frames extraction → `temp/frames/{jobId}/` — **don't touch** |
| `src/server.js` | express + `/frames` static + `/api` routes + `/health` |

**Design note:** we keep the current flat `temp/videos/{jobId}.ext` layout (PLAN.md's target
sketches per-job subfolders, but restructuring downloadService now is churn without benefit —
uploads will mirror the same flat convention).

---

## Task 0.1 — Install `sharp`

**Difficulty: Easy (~5 min)**

What to do:
1. `npm install sharp`
2. Verify install on Windows: `node -e "require('sharp'); console.log('ok')"` → must print `ok`.

Acceptance:
- [ ] `package.json` has `sharp` in `dependencies`.
- [ ] One-line require test passes.

---

## Task 0.2 — Rewrite `src/config.js` (full key surface + boot validation)

**Difficulty: Easy–Medium (~45 min)**

What to do — replace config.js with all keys from PLAN.md, correct parsing, defaults, and validation helpers:

```js
// required new exports (exact names used by later phases):
TEMP_DIR, VIDEO_DIR,
CANDIDATE_DIR   // temp/candidates
ASSET_DIR       // temp/assets
UPLOAD_TMP_DIR  // temp/uploads  (used in Phase 1 — add now)
PORT,
YT_DLP_PATH, FFMPEG_PATH, FFPROBE_PATH,
MAX_VIDEO_DURATION_SEC,   // int, default 600
MAX_UPLOAD_MB,            // int, default 500
SAMPLE_FPS,               // float, default 1
MIN_ASSET_STILL_SEC,      // float, default 0.8
PHASH_HAMMING_THRESHOLD,  // int, default 10
MAX_CANDIDATES,           // int, default 60
VISION_MODEL,             // string, default 'claude-sonnet-5'
VISION_BATCH_SIZE,        // int, default 5
CLAUDE_TIMEOUT_MS,        // int, default 60000
ASSET_RETENTION_HOURS,    // int, default 24
ANTHROPIC_API_KEY,        // string, default ''

// new helpers:
ensureDir(dir)                    // fs.mkdirSync(dir, {recursive:true})
assertBinaries()                  // spawnSync(`${bin} -version`) for ffmpeg/ffprobe/yt-dlp
validateConfig({ allowMissingApiKey = true })
```

Rules:
- `assertBinaries()` throws with a message naming the missing binary and pointing to README install notes. Call it in `server.js` boot (fail fast).
- Missing `ANTHROPIC_API_KEY` → `console.warn` only (Phases 0–2 don't need it).
- Keep exporting `FRAME_DIR` (existing legacy all-frames route still uses it until Phase 5) — do not remove anything currently required by other files.

Acceptance:
- [ ] `node -e "console.log(require('./src/config'))"` prints every key with sane types.
- [ ] Start with a bogus `FFMPEG_PATH=nope` → server exits with clear error, not silent boot.

---

## Task 0.3 — Create `src/utils/ffmpeg.js` (spawn wrappers + filter-output parsers)

**Difficulty: Medium (~1–1.5 h)** — the parsing functions are the delicate part; write them now, exercised for real in Phase 2.

What to do:

```js
runFfmpeg(args)        // Promise<{stdout,stderr}>; spawn(FFMPEG_PATH,args); reject Error with last 500 chars of stderr on exit!=0; reject on spawn 'error' (ENOENT)
runFfprobe(args)       // same pattern, FFPROBE_PATH, resolves stdout string
formatTimecode(sec)    // 23.1 -> "00:23" ; 75 -> "01:15" ; use Math.floor, pad MM/SS
parseTimecode(tc)      // "00:23" -> 23 ; also accept ffmpeg "00:00:23.10"
parseFreezeDetect(stderr) // -> [{start, end}] seconds (end=Infinity for tillEnd)
parseSceneDetect(stderr)  // -> [timestampSec, ...]
```

Implementation details that matter:
- ffmpeg writes filter logs to **stderr** and line-wraps: accumulate the buffer, split on `/\r?\n/` **and** also handle records separated by nothing (older builds) — keep it simple: split lines, regex each.
- `freezedetect` lines look like:
  `[freezedetect @ ...] lavfi.freezedetect.freeze_start: 12.34` / `freeze_duration: 5.2` / `freeze_end: 17.54`
  Parse the three keys, pair start→end; treat missing end as `Infinity`.
- `scene` detection comes from `-vf "select='gt(scene,0.3)',metadata=print"` lines like
  `frame:0 ... pts_time:23.12` → collect `pts_time` values.
- Do **not** use `shell: true` — pass args array (safe against path quoting on Windows).
- Reject if spawned process both fails to start and never emits close (guard the double-settle with a `settled` flag).

Acceptance (create `src/utils/ffmpeg.test.js`-style manual script or `node -e` checks):
- [ ] `formatTimecode(23.1)==='00:23'`, `formatTimecode(3661.5)==='61:01'` (minutes may exceed 59 — fine for v1, document it).
- [ ] Run `ffmpeg -i sample.mp4 -vf freezedetect=n=-60dB:d=0.5 -map 0:v -f null -` on a generated test clip (below) and `parseFreezeDetect` output matches the clip's actual frozen window ±0.2s.
- [ ] Spawning a nonexistent binary rejects with readable error (server must not hang).

**Test fixture generation (no real video needed):**

```bash
# 5s clip: 2s moving pattern, then 3s frozen frame
ffmpeg -y -f lavfi -i "testsrc=duration=2:size=320x240:rate=25" -frames:v 50 a.mp4
ffmpeg -y -loop 1 -i a.mp4 ... # or simpler:
ffmpeg -y -f lavfi -i "testsrc=duration=5:size=320x240:rate=25" -vf "trim=0:2,setpts=PTS-STARTPTS" -r 25 freeze_part.mp4
# Easiest reliable fixture:
ffmpeg -y -f lavfi -i "testsrc=duration=5:size=320x240:rate=25" -vf "fps=25" sample.mp4   # moving
ffmpeg -y -f lavfi -i "color=c=red:s=320x240:d=5:r=25" red.mp4                            # fully frozen
```

`red.mp4` must yield exactly one freeze span covering 0–5s. `sample.mp4` must yield none.

---

## Task 0.4 — Extend `src/services/jobService.js` to the canonical job shape

**Difficulty: Easy (~30 min)**

What to do — additive only; existing fields (`frameDir`, `frameCount`) stay so the legacy route keeps working until Phase 5:

```js
const job = {
  id, status: 'pending',
  // canonical status set (documented, not enforced as enum):
  // pending|downloading|uploading|sampling|filtering|analyzing|done|failed
  sourceType: null,        // 'youtube' | 'upload' | null
  sourceUrl: null,
  originalFilename: null,
  videoPath: null,
  duration: null,
  progress: 0,
  candidates: [],          // Phase 2
  assets: [],              // Phase 3-4
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...data,
};
```

- `updateJob(id, patch)` — must set `updatedAt` on every call.
- `createJob(id, data)` — accepts initial patch (e.g. `{sourceType:'youtube', sourceUrl}`).
- Add `listJobs()` → array of summary objects `{id, status, sourceType, assetCount, createdAt}` (used by Phase 5, harmless now).
- Add `getJobOrThrow(id)` for internal use.

Acceptance:
- [ ] Old extract flow still transitions `pending→downloading→extracting→done` (note: old code uses `extracting` — the legacy pipeline may keep that string until Phase 2 replaces the flow; do not break it).
- [ ] `updateJob` always advances `updatedAt`; unknown id returns `null`.

---

## Task 0.5 — Create stubs `src/utils/hash.js` and `src/utils/sharpness.js`

**Difficulty: Easy (~15 min)**

What to do — export placeholder functions with the exact signatures Phase 2 will implement, so imports compile everywhere:

```js
// hash.js
module.exports = { dhashFromFile, hamming };   // async (path)->string(16 hex) ; (a,b)->int
// sharpness.js
module.exports = { sharpnessFromFile };        // async (path)->number
```

Stubs may `throw new Error('implemented in Phase 2')`. Keep the doc-comment contract in the file.

Acceptance:
- [ ] `require` both files without error; stubs throw only when called.

---

## Task 0.6 — Boot tasks in `src/server.js`

**Difficulty: Easy (~20 min)**

What to do:
1. `require('dotenv').config()` already first line — keep.
2. On boot: `assertBinaries()`, `validateConfig()`, then `ensureDir()` for:
   `VIDEO_DIR, CANDIDATE_DIR, ASSET_DIR, UPLOAD_TMP_DIR, FRAME_DIR` (legacy).
3. Log a boot summary: ffmpeg/ffprobe/yt-dlp resolved values + whether API key present.

Acceptance:
- [ ] Delete `temp/` entirely → boot recreates all 5 subdirs.
- [ ] Boot order matters: validation failure exits non-zero before `app.listen`.

---

## Task 0.7 — Update `.env.example` (+ create local `.env`)

**Difficulty: Easy (~15 min)**

What to do — every key from Task 0.2 with Vietnamese comments in the existing style, e.g.:

```
# Tần số lấy mẫu khi dò frame tĩnh (frame/giây)
SAMPLE_FPS=1
# Ngưỡng khác biệt perceptual hash để gộp frame trùng (0-64 bit)
PHASH_HAMMING_THRESHOLD=10
# Key Anthropic — cần từ Phase 3 (Vision)
ANTHROPIC_API_KEY=
```

Acceptance:
- [ ] Fresh `cp .env.example .env` boots the server with zero code changes.

---

## Task 0.8 — Regression check (whole phase definition-of-done)

**Difficulty: Easy (~30 min)**

What to do:
1. `npm start`, submit `POST /api/extract` with a short public YouTube video (or the local `sample.mp4` if you temporarily point a test at it).
2. Poll `GET /api/jobs/:id` to `done`; `GET /api/jobs/:id/frames` non-empty; `GET /api/jobs/:id/download` zip opens.
3. Confirm job JSON now carries the new fields (`sourceType`, `assets: []`, `updatedAt`, ...).

Acceptance = **Phase 0 Definition of Done**:
- [ ] Tasks 0.1–0.7 acceptance lists all green.
- [ ] Zero regressions on existing endpoints.
- [ ] `git diff` review: no changes to `downloadService.js`, `frameExtractionService.js`, `videoInfo.js`.

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 0.1 | Install sharp | Easy | 5 min |
| 0.2 | Rewrite config.js + validation | Easy–Medium | 45 min |
| 0.3 | utils/ffmpeg.js wrappers + parsers | **Medium** | 1–1.5 h |
| 0.4 | jobService canonical shape | Easy | 30 min |
| 0.5 | hash/sharpness stubs | Easy | 15 min |
| 0.6 | server.js boot tasks | Easy | 20 min |
| 0.7 | .env.example | Easy | 15 min |
| 0.8 | Regression check / DoD | Easy | 30 min |
| | **Total** | **Easy overall** | **~4–5 h** |

## Copy-paste agent prompt (Phase 0, all tasks)

```
Implement Phase 0 of docs/PLAN.md exactly as specified in docs/PLAN-phase-0.md.
Work through tasks 0.1 → 0.8 in order; each task's "Acceptance" checkboxes must pass
before moving on. Do NOT implement any detection/vision logic. The existing
POST /api/extract pipeline must still reach status 'done' with a working zip download.
Files you may modify: src/config.js, src/services/jobService.js, src/server.js, .env.example, package.json.
Files you must create: src/utils/ffmpeg.js, src/utils/hash.js (stub), src/utils/sharpness.js (stub).
Files you must NOT change: src/services/downloadService.js, src/services/frameExtractionService.js, src/utils/videoInfo.js.
```
