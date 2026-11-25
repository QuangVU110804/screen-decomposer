# Phase 4 — Detailed Plan: Asset Extraction & Finalization

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 2](./PLAN-phase-2.md), [Phase 3](./PLAN-phase-3.md).
> **Difficulty: Easy.** This phase does almost no new logic — it renames/copies files Phase 2
> already produced and Phase 3 already confirmed, plus generates thumbnails.
> Definition of done: `temp/assets/:jobId/` contains exactly `asset_001.png`, `asset_001_thumb.jpg`,
> ... `manifest.json`, matching `job.assets` 1:1, ordered by timestamp.

**What you have coming in:** `job.assets` = array of `{label, description, confidence, timestamp, timecode, framePath}` where `framePath` still points into `temp/candidates/:jobId/frames/f_000NN.png` (Phase 3's output). Nothing has been copied into a final, stable location yet — candidates are considered temp/scratch and Phase 7 will eventually delete them.

---

## Task 4.1 — `assetExtractionService.finalizeAssets(job)`

**Difficulty: Easy (~1 h)**

```js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { formatTimecode } = require('../utils/ffmpeg');

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 80;

async function finalizeAssets(job) {
  const dir = path.join(config.ASSET_DIR, String(job.id));
  // idempotent: wipe any previous partial run before regenerating
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const sorted = [...job.assets].sort((a, b) => a.timestamp - b.timestamp);
  const finalized = [];

  for (let i = 0; i < sorted.length; i++) {
    const n = i + 1;
    const asset = sorted[i];
    const base = `asset_${String(n).padStart(3, '0')}`;
    const pngPath = path.join(dir, `${base}.png`);
    const thumbPath = path.join(dir, `${base}_thumb.jpg`);

    await fs.promises.copyFile(asset.framePath, pngPath);
    await sharp(asset.framePath)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath);

    finalized.push({
      index: n,
      label: asset.label,
      description: asset.description,
      confidence: asset.confidence,
      timestamp: asset.timestamp,
      timecode: asset.timecode || formatTimecode(asset.timestamp),
      framePath: pngPath,
      thumbPath,
    });
  }

  const manifest = {
    jobId: job.id,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl || null,
    generatedAt: new Date().toISOString(),
    assetCount: finalized.length,
    assets: finalized.map(a => ({ index: a.index, label: a.label, description: a.description, timestamp: a.timestamp, timecode: a.timecode, confidence: a.confidence, file: path.basename(a.framePath), thumb: path.basename(a.thumbPath) })),
  };
  await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return finalized;
}

module.exports = { finalizeAssets };
```

Notes:
- **Copy, don't move** — `temp/candidates` stays owned by Phase 2/7's cleanup, this phase never deletes source files it didn't create.
- Numbering is **always** by sorted timestamp, recomputed fresh each run (handles the idempotent-rerun case cleanly — no leftover `asset_009.png` from a previous run with more assets).
- `manifest.json`'s file/thumb fields store **basenames only** — absolute filesystem paths never leave the server (Phase 5 builds public URLs from these).

Acceptance:
- [ ] 4 confirmed assets in `job.assets` (unsorted input order) → `asset_001..004.png` created in ascending timestamp order regardless of input order.
- [ ] Each `asset_00N_thumb.jpg` is ≤ 320px wide, valid JPEG, opens in an image viewer.
- [ ] `asset_00N.png` is byte-identical to its source candidate file (`fs.readFileSync` compare) — no re-encoding of the full-size image.
- [ ] `manifest.json` parses as valid JSON and `assetCount === job.assets.length`.

---

## Task 4.2 — Idempotent re-run guarantee

**Difficulty: Easy (~20 min)**

Because `finalizeAssets` wipes `temp/assets/:jobId` at the start, re-running it twice on the same job (e.g. a manual retry) never accumulates stale files. Verify explicitly rather than assuming:

Acceptance:
- [ ] Run `finalizeAssets(job)` twice in a row with the same job → second run produces the same file set, no `asset_005.png` leftover from a first run that had 5 and a second that has 4.
- [ ] Run once with 5 assets, then again after removing one from `job.assets` (simulating a re-analysis with fewer confirmed) → directory ends with exactly 4, not 5.

---

## Task 4.3 — Wire into the pipeline; update job with final asset records

**Difficulty: Easy (~30 min)**

`runIngested` in `extractRoutes.js`, final segment:

```js
  // ...after visionService.classifyCandidates (Phase 3) sets job.assets from candidates...
  updateJob(jobId, { status: 'finalizing', progress: 92 });
  const finalized = await assetExtractionService.finalizeAssets(getJob(jobId));
  updateJob(jobId, { assets: finalized, status: 'done', progress: 100 });
```

Note the extra `finalizing` status between `analyzing` and `done` — cheap to add, gives the UI (Phase 6) one more accurate label instead of jumping straight from 90% to done.

Acceptance:
- [ ] Full pipeline run (URL or upload) ends with `job.status === 'done'` and `job.assets[].framePath` pointing into `temp/assets/:jobId/asset_00N.png` (not the old candidates path).
- [ ] If `job.assets` is empty (no confirmed assets — legitimate for a plain talking-head video), finalize still runs cleanly: creates an empty dir + `manifest.json` with `assetCount:0`, job still reaches `done` (not `failed` — zero assets found is a valid outcome, not an error).

---

## Task 4.4 — Failure-path safety net

**Difficulty: Easy (~20 min)**

If `finalizeAssets` throws (disk full, permissions, sharp decode error on a corrupted candidate), the job must land in `failed` with a clear message — not `done` with missing files, and not an unhandled promise rejection that crashes the server.

```js
try {
  const finalized = await assetExtractionService.finalizeAssets(getJob(jobId));
  updateJob(jobId, { assets: finalized, status: 'done', progress: 100 });
} catch (err) {
  updateJob(jobId, { status: 'failed', error: `Lỗi khi hoàn tất asset: ${err.message}` });
}
```
(This wraps into the existing outer try/catch already present in `runIngested`/`runUrl`/`runUpload` from Phase 1 — verify it's not swallowed by an inner try that already resolved.)

Acceptance:
- [ ] Simulate a corrupted candidate file (truncate one candidate PNG to 0 bytes) mid-run → job ends `failed` with the Vietnamese message, server keeps running, other jobs unaffected.

---

## Phase 4 Definition of Done

- [ ] Tasks 4.1–4.4 acceptance all green.
- [ ] `temp/assets/:jobId/` is the **only** place Phase 5/6 ever reads finished asset images from.
- [ ] `git diff`: `candidateService.js` and `visionService.js` untouched — Phase 4 only consumes their output.

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 4.1 | `finalizeAssets`: copy + thumbnail + manifest | Easy | 1 h |
| 4.2 | Idempotent re-run verification | Easy | 20 min |
| 4.3 | Pipeline wiring + `finalizing` status | Easy | 30 min |
| 4.4 | Failure-path safety net | Easy | 20 min |
| | **Total** | **Easy** | **~2–2.5 h** |

This is the lightest phase in the plan — a good phase to do quickly and move on.

## Copy-paste agent prompt (Phase 4, all tasks)

```
Implement Phase 4 of docs/PLAN.md exactly as specified in docs/PLAN-phase-4.md.
Phase 3 is complete: job.assets exists with {label,description,confidence,timestamp,
timecode,framePath} where framePath points into temp/candidates.

1. Create src/services/assetExtractionService.js exporting finalizeAssets(job):
   wipe+recreate temp/assets/<jobId>, sort job.assets by timestamp, copy each framePath to
   asset_00N.png (1-indexed, padded 3 digits), generate a 320px-wide JPEG thumbnail
   asset_00N_thumb.jpg via sharp (quality 80), write manifest.json with basenames only
   (never absolute fs paths). Return the finalized array with updated framePath/thumbPath
   pointing into temp/assets.
2. Wire into runIngested in extractRoutes.js after the Vision step: status 'finalizing'
   at progress 92, then call finalizeAssets, replace job.assets with the finalized array,
   set status 'done' progress 100. Zero confirmed assets is a valid outcome (done, empty
   assets array, manifest with assetCount:0) — not a failure.
3. Wrap the finalize call so any thrown error sets the job to 'failed' with message
   "Lỗi khi hoàn tất asset: <err.message>" instead of crashing the process.
4. Verify idempotency: running finalizeAssets twice on the same job (including with a
   shrunken assets array) never leaves stale files behind.

Do not modify candidateService.js or visionService.js.
```
