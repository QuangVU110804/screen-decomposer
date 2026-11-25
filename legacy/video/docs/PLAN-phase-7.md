# Phase 7 — Detailed Plan: Hardening & Cleanup

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 6](./PLAN-phase-6.md) done — the full pipeline
> and UI work end-to-end for a single happy-path run.
> **Difficulty: Medium.** No single task is conceptually hard, but this phase is where
> "works once in a demo" becomes "safe to leave running." Concurrency and cleanup bugs are
> easy to introduce and easy to miss without deliberately trying to break them.
> Definition of done: the server can run for days handling a stream of jobs — good and bad —
> without disk growing unbounded, without ffmpeg/Vision calls piling up concurrently, and
> without any single failure taking the process down.

**What's already true going in:** every pipeline stage (Phases 1–4) already wraps its own
errors into `job.status='failed'` — this phase adds the **outer** safety nets: concurrency,
retention, and a final audit that nothing was missed.

---

## Task 7.1 — Single-flight pipeline queue

**Difficulty: Medium (~1.5 h)**

Today, `POST /api/extract` fires `runPipeline`/`runUrl`/`runUpload` immediately in the background with no concurrency limit — 10 rapid submissions spawn 10 simultaneous ffmpeg + yt-dlp + Vision-batch chains, saturating CPU/network and making progress numbers meaningless (they all fight for the same resources).

```js
// src/services/pipelineQueue.js
const MAX_QUEUE_WAITING = 5;

let running = false;
const queue = []; // [{jobId, task}]

function enqueue(jobId, task) {
  if (running) {
    if (queue.length >= MAX_QUEUE_WAITING) {
      throw new Error('Hàng đợi đầy, vui lòng thử lại sau vài phút');
    }
    queue.push({ jobId, task });
    updateJob(jobId, { status: 'pending', queuePosition: queue.length });
    return;
  }
  run(jobId, task);
}

async function run(jobId, task) {
  running = true;
  try { await task(); }
  finally {
    running = false;
    if (queue.length) {
      const next = queue.shift();
      queue.forEach((q, i) => updateJob(q.jobId, { queuePosition: i + 1 }));
      run(next.jobId, next.task);
    }
  }
}

module.exports = { enqueue };
```

Wire into the routes: `POST /api/extract` / `.../upload` call `pipelineQueue.enqueue(jobId, () => runUrl(jobId, url))` instead of firing `runUrl` directly. A full queue throws synchronously in the route handler → caught and returned as `429`.

Why single-flight (not e.g. concurrency=3): ffmpeg and Vision calls are already the bottleneck; running several jobs' ffmpeg processes concurrently on a laptop just makes every job slower with no net throughput gain, and it makes progress percentages lie. Simpler to reason about too — revisit only if real usage demands it (YAGNI).

Acceptance:
- [ ] Fire 10 `POST /api/extract` calls in a tight loop → exactly 1 ffmpeg process running at a time (verify via `tasklist`/Task Manager or a log counter incremented at task start/end).
- [ ] Jobs 2–6 show `status:'pending'` with an increasing `queuePosition`; job 7+ gets `429 {error:'Hàng đợi đầy...'}`.
- [ ] If job 1 throws, job 2 still starts (the `finally` block runs regardless of success/failure).
- [ ] Server restart clears the queue cleanly (it's in-memory — document this as an accepted limitation, matching the existing job store).

---

## Task 7.2 — Temp cleanup service (retention sweep)

**Difficulty: Medium (~1.5 h)**

```js
// src/services/cleanupService.js
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

function isStale(dirPath, retentionHours) {
  const stat = fs.statSync(dirPath);
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  return ageHours > retentionHours;
}

function sweepOnce() {
  for (const base of [config.VIDEO_DIR, config.CANDIDATE_DIR, config.ASSET_DIR, config.UPLOAD_TMP_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const full = path.join(base, entry);
      try {
        if (isStale(full, config.ASSET_RETENTION_HOURS)) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`[cleanup] removed ${full}`);
        }
      } catch (err) { console.warn(`[cleanup] failed on ${full}: ${err.message}`); }
    }
  }
}

function startCleanupScheduler() {
  sweepOnce(); // run once at boot too, in case of a long-downed server
  setInterval(sweepOnce, SWEEP_INTERVAL_MS);
}

module.exports = { startCleanupScheduler, sweepOnce };
```

Also add: once `findCandidates` (Phase 2) succeeds for a job, **delete that job's source video file** — it's the single biggest disk consumer and nothing downstream needs it (candidates + eventually assets are self-contained). Add this as one line at the end of Phase 2's stage in `runIngested`:

```js
await fs.promises.unlink(videoPath).catch(() => {});   // best-effort; video no longer needed
```

Rules:
- Cleanup keys off **directory mtime**, which updates when files inside are added — a job actively being written to won't look stale mid-run (as long as `ASSET_RETENTION_HOURS` is sane, e.g. 24h, vs. a job that takes minutes). Document this coupling.
- Never sweep a job's own currently-active directories — since a run typically finishes in minutes and retention defaults to hours, this is naturally safe without extra locking, but call it out in a comment.
- Wrap each `rmSync` individually — one locked file (Windows sometimes holds a handle briefly after ffmpeg exits) must not abort the whole sweep.

Acceptance:
- [ ] Manually backdate a job's directory mtime (Node script: `fs.utimesSync(dir, oldTime, oldTime)`) past `ASSET_RETENTION_HOURS` → next `sweepOnce()` removes it; a fresh job's directory survives.
- [ ] Deleting the video file immediately after Phase 2 candidates succeed → confirmed via `fs.existsSync(job.videoPath)` returning false, while the job still reaches `done` normally (nothing downstream reads `videoPath` again).
- [ ] Simulate a locked file (open a handle to a file inside a stale dir, then sweep) → sweep logs a warning for that one entry and continues to the next, doesn't crash the interval.
- [ ] `startCleanupScheduler()` called once from `server.js` boot; confirm via log line at startup and one more an hour later (or trigger `sweepOnce()` manually in a smoke test).

---

## Task 7.3 — Vision cost guardrail + logging

**Difficulty: Easy (~30 min)**

`MAX_CANDIDATES` (Phase 2) already caps the images sent to Vision, but add explicit visibility so a runaway cost is noticed immediately, not discovered on a bill:

```js
// in visionService.classifyCandidates, before batching:
if (candidates.length > config.MAX_CANDIDATES) {
  console.warn(`[vision] candidates (${candidates.length}) exceed MAX_CANDIDATES (${config.MAX_CANDIDATES}) — this should not happen, truncating defensively`);
  candidates = candidates.slice(0, config.MAX_CANDIDATES);
}
// after all batches:
console.log(`[vision][job ${jobId}] images_sent=${candidates.length} api_calls=${batches.length} confirmed_assets=${assets.length}`);
```

The truncation here is a defensive second gate — Phase 2 already caps candidates, so hitting this path indicates a bug upstream worth investigating, not normal operation.

Acceptance:
- [ ] Log line appears once per completed job with correct counts (cross-check against a manual count from Phase 3's earlier test video).
- [ ] Artificially setting `MAX_CANDIDATES=5` after Phase 2 already produced 20 candidates (simulate by calling classifyCandidates directly with 20 items) → truncates to 5, warns, still completes.

---

## Task 7.4 — Upload safety audit

**Difficulty: Easy (~30 min)** — this is a review pass over Phase 1 code, not new features; call out anything missing.

Checklist against the current `ingestionService`/`multer` setup:
- [ ] Multer `limits.fileSize` matches `config.MAX_UPLOAD_MB` (not a hardcoded number) — re-check after any `.env` key renames across phases.
- [ ] Uploaded files are never served back with their original filename or extension trusted for execution — confirm the on-disk name is always the random UUID (Phase 1) or `<jobId>.<ext>` (post-validation), never `req.file.originalname` directly.
- [ ] `temp/uploads` (multer's staging dir) never accumulates orphans: every code path (success, validation failure, duration-guard failure, mid-pipeline crash) either renames the file away or unlinks it. Add a one-line audit: after a batch of 20 mixed valid/invalid test uploads, `temp/uploads` should be empty.
- [ ] No route serves arbitrary paths under `temp/uploads` or `temp/videos` (only `temp/assets` is exposed via Phase 5's guarded route) — grep `express.static` and confirm only `ASSET_DIR`-equivalent paths are mounted, and only through the allowlisted handler, not raw `express.static`.

Acceptance:
- [ ] The 20-mixed-upload audit above: `temp/uploads` empty afterward.
- [ ] `grep -rn "express.static" src/` shows no exposure of `VIDEO_DIR`, `CANDIDATE_DIR`, or `UPLOAD_TMP_DIR`.

---

## Task 7.5 — Full pipeline error-wrapping audit

**Difficulty: Medium (~1 h)**

Walk every stage in the (by now, final) `runIngested`/`runUrl`/`runUpload` chain and confirm the outer `try/catch` genuinely catches everything, including:

- [ ] A thrown `Error` (the common case — already handled since Phase 1).
- [ ] A **rejected promise from an event-based API** that isn't awaited correctly (e.g. an `ffmpeg` child process `'error'` event on ENOENT if someone changes `FFMPEG_PATH` — verify `runFfmpeg`'s promise wrapper from Phase 0 actually rejects rather than hanging forever). Test: temporarily set `FFMPEG_PATH=doesnotexist` and confirm the job reaches `failed` within a few seconds, not stuck in `sampling` forever.
- [ ] A synchronous throw inside a `.then`/`forEach` callback that isn't wrapped (a classic Node gotcha — `array.forEach(async fn)` swallows rejections silently). Grep the codebase for `.forEach(async` and replace any with a `for...of` loop with `await` inside, since Phases 2–4 likely use loops over candidates/assets.
- [ ] Server-level `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` added as a last-resort logger (log + keep running for unhandledRejection; log + exit for uncaughtException, since the latter means state may be corrupted) — this is the final backstop, not a substitute for fixing root causes found above.

```js
// src/server.js, near the top after other requires
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] — exiting:', err);
  process.exit(1);
});
```

Acceptance:
- [ ] The `FFMPEG_PATH=doesnotexist` test above completes (job `failed`) within 5s, doesn't hang.
- [ ] `grep -rn "forEach(async" src/` → zero matches (or each verified to be genuinely fire-and-forget on purpose, documented as such).
- [ ] Killing the network mid-Vision-call (Phase 3, e.g. disconnect wifi for 5s) → job ends `failed` with a readable message within `CLAUDE_TIMEOUT_MS`, server itself stays up and accepts new jobs afterward.
- [ ] Manually throw inside one pipeline stage during a test run → server logs it, job fails, `GET /health` still returns 200 (process didn't crash).

---

## Task 7.6 — README rewrite

**Difficulty: Easy (~1 h)**

Rewrite the root `README.md` (Vietnamese, matching existing tone) covering:
- New purpose (visual-asset extraction, not raw frame dumps) — reuse the PLAN.md intro framing.
- Updated system requirements (add `ANTHROPIC_API_KEY`).
- Full endpoint table from Phase 5.
- `.env` reference (all keys, grouped: server / binaries / limits / detection tuning / vision).
- Updated "Giới hạn / lưu ý" section: mention the retention sweep (replacing the old "không tự dọn" caveat, since Phase 7 fixes it), the single-flight queue, the Vision cost cap, and keep the existing YouTube ToS note.
- A short "Kiến trúc" section pointing at `docs/PLAN.md` for anyone who wants the full design rationale.

Acceptance:
- [ ] Every env key from `.env.example` is documented in the README.
- [ ] Every route from Phase 5's table appears with method + example body/response.
- [ ] The old "Job lưu trong memory... mất khi restart" and "thư mục không tự dọn" caveats are updated to reflect Phase 7's actual behavior (queue is in-memory and does reset on restart — keep that caveat; cleanup is no longer a caveat, it's a feature — remove/replace that line).

---

## Task 7.7 — Phase 7 Definition of Done (whole-system soak check)

**Difficulty: Medium (~1–1.5 h)**

This is the final gate for the whole v1 plan (Phases 0–7), not just Phase 7's own tasks:

1. Submit 5 jobs back-to-back (mix of URL + upload, one deliberately invalid). Confirm the queue serializes them, all resolve to a terminal state, disk usage after is just the 4 valid jobs' outputs.
2. Backdate one job's output past `ASSET_RETENTION_HOURS`, run a manual sweep, confirm it's gone while the others remain.
3. Restart the server mid-queue (kill while job 3 of 5 is running) → confirms jobs 4-5 are lost (in-memory, expected/documented) but the process comes back up clean and accepts new work.
4. Re-read `README.md` fresh (as if new to the project) and confirm it alone is enough to run the whole thing from `git clone` to a working browser session.

Overall Definition of Done (all phases):
- [ ] Tasks 7.1–7.6 acceptance all green.
- [ ] A 10-minute real video with several inserted images, run end-to-end through the browser UI, produces a labeled, timestamped, downloadable asset set matching the PLAN.md example output shape.
- [ ] The server survives the soak test in step 1–3 above without manual intervention beyond the deliberate restart.

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 7.1 | Single-flight pipeline queue | Medium | 1.5 h |
| 7.2 | Retention sweep + early video deletion | Medium | 1.5 h |
| 7.3 | Vision cost guardrail + logging | Easy | 30 min |
| 7.4 | Upload safety audit (review pass) | Easy | 30 min |
| 7.5 | Error-wrapping audit (`forEach(async)`, hangs, process handlers) | Medium | 1 h |
| 7.6 | README rewrite | Easy | 1 h |
| 7.7 | Whole-system soak check + final DoD | Medium | 1–1.5 h |
| | **Total** | **Medium** | **~7.5–8.5 h** |

**Most valuable single test in this phase:** Task 7.5's `FFMPEG_PATH=doesnotexist` check. A hung promise from a misconfigured binary path is the failure mode most likely to silently freeze a job forever without Phase 0's `runFfmpeg` wrapper being airtight — worth re-verifying here under real pipeline conditions, not just in isolation.

## Copy-paste agent prompt (Phase 7, all tasks)

```
Implement Phase 7 of docs/PLAN.md exactly as specified in docs/PLAN-phase-7.md. This is the
final hardening pass over the complete pipeline built in Phases 0-6.

1. Create src/services/pipelineQueue.js: single-flight in-memory queue (max 5 waiting,
   429 when full), expose enqueue(jobId, taskFn). Wire both POST /api/extract and
   POST /api/extract/upload to enqueue their background pipeline instead of firing it
   directly. Track job.queuePosition while waiting.
2. Create src/services/cleanupService.js: hourly sweep (also once at boot) deleting any
   entry under VIDEO_DIR/CANDIDATE_DIR/ASSET_DIR/UPLOAD_TMP_DIR whose mtime is older than
   ASSET_RETENTION_HOURS, wrapping each deletion so one locked file doesn't abort the sweep.
   Start it from server.js boot. Also: after Phase 2's findCandidates succeeds in the
   pipeline, delete the job's source video file (best-effort unlink) since nothing
   downstream needs it.
3. In visionService, add a defensive truncation + warning if candidates ever exceed
   MAX_CANDIDATES at call time, and a one-line cost-summary log per completed job
   (images_sent, api_calls, confirmed_assets).
4. Audit and fix: no route uses express.static on VIDEO_DIR/CANDIDATE_DIR/UPLOAD_TMP_DIR
   (only the Phase 5 allowlisted /assets/:jobId/:filename route serves files); temp/uploads
   never accumulates orphaned files across success/failure/crash paths; replace any
   array.forEach(async ...) pattern in the pipeline with a for...of loop with awaited
   iterations. Add process-level unhandledRejection (log, keep running) and
   uncaughtException (log, exit 1) handlers in server.js.
5. Verify (and fix if needed) that runFfmpeg/runFfprobe/yt-dlp spawn wrappers reject
   promptly on a missing binary rather than hanging — test with a temporarily invalid
   FFMPEG_PATH and confirm the job reaches 'failed' within ~5s.
6. Rewrite the root README.md (Vietnamese, matching existing tone) with the final purpose,
   full .env reference, full endpoint table, and updated "Giới hạn / lưu ý" section
   reflecting that cleanup/concurrency are now handled (remove outdated caveats, add new
   ones only where real limitations remain — e.g. in-memory queue/job-store reset on restart).
7. Run the whole-system soak check from PLAN-phase-7.md task 7.7 (5 jobs back-to-back mixed
   valid/invalid, backdated retention sweep, mid-queue restart) and report results.

This phase touches routing/orchestration glue in extractRoutes.js and server.js but must not
change the core logic of candidateService.js, visionService.js, or assetExtractionService.js.
```
