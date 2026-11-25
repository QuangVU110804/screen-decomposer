# Phase 2 — Detailed Plan: Candidate Detection (Cheap CV)

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 0](./PLAN-phase-0.md), [Phase 1](./PLAN-phase-1.md).
> **Difficulty: HARD — this is the hardest phase of v1.** It's the core of the product.
> Definition of done: from any accepted video, produce **20–40 candidates** (never hundreds, never 0 unless the video truly has no still inserts), each a *distinct* full-screen still visual, with a timestamp accurate to ±1s. **Zero API calls** in this phase.

**What you have coming in (from Phases 0–1):**

- `src/utils/ffmpeg.js`: `runFfmpeg(args)`, `runFfprobe`, `formatTimecode(sec)`, `parseFreezeDetect(stderr) → [{start,end}]`
- `src/utils/hash.js`, `src/utils/sharpness.js`: **stubs to implement here**
- `config`: `SAMPLE_FPS`, `MIN_ASSET_STILL_SEC`, `PHASH_HAMMING_THRESHOLD`, `MAX_CANDIDATES`, `CANDIDATE_DIR`
- Pipeline: both sources converge on `runIngested(jobId, videoPath, duration)` in `extractRoutes.js` — **its body is what Phase 2 replaces**

**Design decisions locked:**

| # | Decision | Reason |
|---|----------|--------|
| D1 | Three cheap signals combine: **sample → freeze-window → dedupe**. Not one alone. | `freezedetect` alone over-merges (adjacent identical-looking slides) and misses slow zooms; hash alone over-accepts. |
| D2 | `timestamp = (i-1) / SAMPLE_FPS` for sampled file `f_%05d.png` | ffmpeg's `fps=` filter emits frames on a fixed 1/SAMPLE_FPS grid, so arithmetic is exact — no per-frame parsing needed. |
| D3 | Group **consecutive** near-duplicate frames only | v1 output is ordered by appearance; the same asset re-appearing later becomes 2 groups — acceptable (Vision may dedupe by label; not v1's concern). |
| D4 | Representative = **sharpest** frame in the group | Beats first-frame (motion blur) and last-frame (may already be transitioning). |
| D5 | Cap at `MAX_CANDIDATES` by earliest timestamp | Directly bounds Phase 3 cost. |
| D6 | Full-frame analysis is the only detection mode | Overlay/PiP explicitly out of scope (PLAN.md Phase 8). |
| D7 | Candidates live on disk in `temp/candidates/:jobId/` + metadata on `job.candidates` | Lets us verify with our eyes before spending any Vision tokens. |

---

## Task 2.1 — Implement `dhashFromFile` + `hamming` in `src/utils/hash.js`

**Difficulty: Medium (~1.5 h)** — correctness here decides whether dedupe works at all.

dHash (difference hash): resize to 9×8 grayscale, compare each pixel to its right neighbor → 64 bits. Robust to brightness/scale changes, cheap, no external binary needed. `sharp` gives everything we need.

```js
const sharp = require('sharp');

/**
 * 64-bit dHash as a 16-char lowercase hex string.
 * @param {string} path  PNG/JPG on disk
 */
async function dhashFromFile(path) {
  // width 9 (need 8 horizontal comparisons), height 8
  const { data, info } = await sharp(path, { failOn: 'none' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })   // fit:'fill' on purpose: force exact grid, ignore AR
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width; // 9
  const g = (x, y) => data[y * W + x];

  let bits = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits += g(x, y) > g(x + 1, y) ? '1' : '0';   // 64 bits

  return bits.match(/.{4}/g)
    .map((nibble) => parseInt(nibble, 2).toString(16))
    .join('');                                      // 16 hex chars
}

/** Hamming distance between two 16-hex-char dHash strings (0..64). */
function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    throw new Error(`hamming: hash length mismatch (${a?.length} vs ${b?.length})`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }          // popcount per nibble
  }
  return dist;
}

module.exports = { dhashFromFile, hamming };
```

Rules:
- `fit: 'fill'` is deliberate — a *distorted* 9×8 grid is the same distortion for every frame, so comparisons stay consistent. Do **not** use `fit: 'cover'` (crops different regions per AR → unstable hashes).
- `failOn: 'none'` so a corrupt sampled PNG degrades instead of throwing mid-loop (see 2.7 test).
- Hash string must be lowercase 16 hex chars — `hamming` relies on parity with `a.length`.
- Keep both pure functions, no I/O beyond `sharp(path)`.

Acceptance:
- [ ] A frame vs a **brightness-shifted copy** of it: `hamming <= 3`. (`sharp b.png .modulate(brightness=1.2)` or ffmpeg `eq=brightness=0.2`)
- [ ] A frame vs a **resized copy**: `hamming <= 3`.
- [ ] Two unrelated images: `hamming >= 20`.
- [ ] `hamming(a,a) === 0`; `hamming` of the two fixture videos below ≥ 30 (red vs testsrc).
- [ ] Corrupt/truncated PNG file → rejects with readable error, no infinite loop.

**Fixtures (generate once, keep in `test/fixtures/`, `.gitignore` it):**

```bash
# A: two images that are near-identical except tiny crop/shift  → must dedupe
ffmpeg -y -f lavfi -i "smptebars=s=640x480:d=1" -frames:v 1 bars.png
ffmpeg -y -i bars.png -vf "eq=brightness=0.1:saturation=1.1" bars_bright.png
ffmpeg -y -i bars.png -vf "scale=320:240,scale=640:480" bars_resized.png
# B: clearly different
ffmpeg -y -f lavfi -i "color=c=red:s=640x480" -frames:v 1 red.png
ffmpeg -y -f lavfi -i "testsrc=s=640x480" -frames:v 1 testsrc.png
```

---

## Task 2.2 — Implement `sharpnessFromFile` in `src/utils/sharpness.js`

**Difficulty: Medium (~1–1.5 h)**

Variance of Laplacian (standard blur metric), computed on `sharp`'s raw grayscale buffer. Downscale first: we only need relative ranking, and this is O(pixels) in JS.

```js
const sharp = require('sharp');

const WORK_SIZE = 480; // longest edge; keeps it fast and the comparison fair

/** Variance of the Laplacian of a 3x3 kernel. Higher = sharper. */
async function sharpnessFromFile(path) {
  const { data, info } = await sharp(path, { failOn: 'none' })
    .grayscale()
    .resize({ width: WORK_SIZE, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width, H = info.height;
  const K = [0, 1, 0, 1, -4, 1, 0, 1, 0]; // Laplacian, row-major 3x3

  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let r = 0;
      let k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          r += data[(y + ky) * W + (x + kx)] * K[k];
          k++;
        }
      }
      sum += r; sumSq += r * r; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
```

> ⚠️ Write the inner loop out plainly with an explicit index increment — no clever comma tricks. Clarity beats cleverness; a wrong index here silently corrupts every ranking. (An earlier draft of this doc had `for (let kx=-1; kx<=1 kx++, k++)` — a missing semicolon that doesn't even parse. Copy the block above, not any version you might recall from memory.)

Rules:
- Border pixels excluded (kernel needs neighbors).
- **Same resize for every candidate** — otherwise a bigger frame always "wins" sharpness. This is a real trap: `sharp().resize(grayscale)` **without** resizing → larger frames get more pixels in the kernel variance, biased ranking. Always normalize.
- Returns an absolute number that means nothing alone; only comparisons within a group matter.
- Guard `n === 0` (tiny/degenerate images) → `0`.

Acceptance:
- [ ] Fixture pairs generated below → sharp value of the blurred one is **at least 5× lower** than the sharp one.
- [ ] Sharpness is resolution-normalized: `sharpnessFromFile(x.png) ≈ sharpnessFromFile(x_downscaled_then_up.png)` within ~30%.
- [ ] A fully-flat-color image scores ~0 (Laplacian of constant = 0) — proves the metric isn't just "variance".

```bash
# fixture pair: sharp text vs blurred
ffmpeg -y -f lavfi -i "testsrc2=s=640x480:d=1" -frames:v 1 sharp_a.png
ffmpeg -y -i sharp_a.png -vf "gblur=sigma=4" blur_a.png
# flat
ffmpeg -y -f lavfi -i "color=c=gray:s=640x480" -frames:v 1 flat.png
```

---

## Task 2.3 — ffmpeg 1-fps sampling into `temp/candidates/:jobId/frames/`

**Difficulty: Easy–Medium (~45 min)**

```js
const { runFfmpeg } = require('../utils/ffmpeg');

async function sampleFrames(videoPath, jobId, onProgress) {
  const dir = path.join(config.CANDIDATE_DIR, String(jobId), 'frames');
  config.ensureDir(dir);
  const out = path.join(dir, 'f_%05d.png');

  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'info',
    '-i', videoPath,
    '-vf', `fps=${config.SAMPLE_FPS}`,
    '-an', '-sn', '-dn',
    '-vsync', '0',
    out,
  ];
  await runFfmpeg(args);          // runFfmpeg already collects stderr
  const files = fs.readdirSync(dir).filter(f => /^f_\d{5}\.png$/.test(f)).sort();
  // f_00001.png -> t = 0
  return files.map((f, idx) => ({
    path: path.join(dir, f),
    index: idx + 1,
    timestamp: idx / config.SAMPLE_FPS,
  }));
}
```

Notes:
- `-an -sn -dn`: audio/subs/data out. `-vsync 0` (a.k.a. passthrough): the fps filter already emits exactly what we want; don't let ffmpeg inject duplicates.
- PNG not JPG here: sharpness/hashing on lossless frames. (Phase 3 will re-encode to small JPEGs *for Vision*, not here.)
- Don't use `-y` unless you add it — `runFfmpeg` writes to a fresh dir, but add `-y` anyway for idempotent re-runs.

Acceptance:
- [ ] 10s sample video at `SAMPLE_FPS=1` → exactly ~10 files, `files[3].timestamp === 3`.
- [ ] `SAMPLE_FPS=2` doubles the file count (verifies the config key is actually wired).

---

## Task 2.4 — Still-segment extraction (`freezedetect`)

**Difficulty: Medium (~1–1.5 h)** — the config sensitivity lives here.

```js
async function detectStillSpans(videoPath) {
  const noiseDb = config.FREEZE_NOISE_DB || '-50dB';   // add FREEZE_NOISE_DB to config.js/.env.example (see below)
  const args = [
    '-hide_banner', '-nostats',
    '-i', videoPath,
    '-vf', `freezedetect=n=${noiseDb}:d=${config.MIN_ASSET_STILL_SEC}`,
    '-map', '0:v:0',
    '-an', '-f', 'null', '-',
  ];
  const { stderr } = await runFfmpeg(args);
  return parseFreezeDetect(stderr);   // Phase 0 helper -> [{start,end}]
}

function frameTimestampInAnySpan(ts, spans, tolSec = 0.5) {
  return spans.some(s => ts >= s.start - tolSec && ts <= s.end + tolSec);
}
```

> The bash-style `${config.X:-default}` syntax does **not** work inside a JS template literal — it's shell syntax, not JavaScript. Use `config.FREEZE_NOISE_DB || '-50dB'` as shown above.

**Why not ffmpeg's own `-60dB` default:** freezedetect's `n` is a **noise threshold** in dB below reference; a *more negative* number is stricter (needs near-perfectly-identical frames). Inserted still images with a faint moving watermark / animated caption will **fail** at -60dB. So:

- Default to `n=-50dB:d=MIN_ASSET_STILL_SEC` — catches stills with minor noise.
- Add `FREEZE_NOISE_DB=-50dB` to `config.js` and `.env.example` now (alongside the Task 2.5 keys) and rely on the fallback path (Task 2.5) rather than tuning per-video.

Acceptance:
- [ ] On a generated slideshow fixture (below) → spans detected for each slide, count == number of slides.
- [ ] On continuous motion (moving testsrc, no holds) → `[]`.
- [ ] `-d` respects `MIN_ASSET_STILL_SEC` (set 10 → finds nothing in a 1s-hold clip).

**Slideshow fixture generator** — this is the single most useful artifact of Phase 2; make it, keep it, test against it:

```bash
# make_slideshow.sh — 8 slides, 4s each, 6s intro + 5s outro of motion = 43s
set -e
i=0; inputs=""; filters=""
for c in red green blue yellow magenta cyan orange gray; do
  i=$((i+1))
  ffmpeg -y -f lavfi -i "color=c=${c}:s=640x480:r=25:d=4" s${i}.mp4
  inputs="$inputs -i s${i}.mp4"
done
ffmpeg -y -f lavfi -i "testsrc2=s=640x480:r=25:d=6" intro.mp4
ffmpeg -y -f lavfi -i "testsrc=s=640x480:r=25:d=5"  outro.mp4
list="file 'intro.mp4'"; for n in $(seq 1 $i); do list="$list
file 's${n}.mp4'"; done; list="$list
file 'outro.mp4'"
echo "$list" > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c:v libx264 -pix_fmt yuv420p slideshow.mp4
```

Expect candidates: **8** (the 8 solid-color slides), timestamps ≈ 6,10,14,18,22,26,30,34s.

---

## Task 2.5 — Fallback path: scene cuts when `freezedetect` finds nothing

**Difficulty: Medium (~1 h)**

A video where the "asset" has a moving overlay (animated lower-third, webcam frame, subtle zoom/pan — the "Ken Burns effect" on a photo) is **not** a freeze by freezedetect's definition. Without a fallback, we silently return 0 assets and the user thinks the tool is broken.

Rule: if `detectStillSpans` yields fewer than 2 spans (or spans cover < 3% of the video), fall back to scene-cut candidates:

```js
async function detectSceneCuts(videoPath) {
  const args = [
    '-hide_banner', '-nostats', '-i', videoPath,
    '-vf', `select='gt(scene,${config.SCENE_THRESHOLD ?? 0.3})',metadata=print`,
    '-vsync', 'v0', '-f', 'null', '-',
  ];
  const { stderr } = await runFfmpeg(args);
  return parseSceneCuts(stderr);   // add to utils/ffmpeg.js: -> [{timestamp}]
}
```

Then treat each cut timestamp as a candidate window start, pick the frame sampled just *after* the cut (`t + 1/SAMPLE_FPS`), and continue with the same hash-dedupe + sharpness steps.

Add to config + `.env.example` (includes `FREEZE_NOISE_DB` from Task 2.4, declared here since this is where the fallback tuning keys live together):
```
# Nguong nhieu cho freezedetect (it nghiem khac hon default -60dB cua ffmpeg de bat duoc
# anh tinh co watermark/caption dong nhe)
FREEZE_NOISE_DB=-50dB
# freezedetect khong tim thay du span tinh -> roi sang duong canh bao (scene cuts)
FALLBACK_TO_SCENE_CUTS=true
SCENE_THRESHOLD=0.3
MAX_SCENE_CANDIDATES=25
```
When the fallback fires, set `job.detectionMode = 'freeze' | 'scene_fallback'` so Phase 3/4 and the UI can tell the user this run was lower-confidence.

Acceptance:
- [ ] A photo-with-zoom video (Ken Burns fixture: `zoompan` on a PNG) returns ≥ 1 candidate via the fallback path (would be 0 via freeze).
- [ ] With `FALLBACK_TO_SCENE_CUTS=false`, the same input returns 0 candidates and the job still completes (`done` with empty assets) — must not error.
- [ ] `job.detectionMode` is set correctly in both runs.

---

## Task 2.6 — `src/services/candidateService.js`: orchestration, dedupe grouping, representative pick

**Difficulty: HARD (~3–4 h)** — the heart of the phase. Get this right and everything downstream is easy.

Public API:

```js
/**
 * @param {object} job        canonical job (has .id, .videoPath)
 * @param {function} onProgress (pct0to1, stageName) => void
 * @returns {Promise<Array<Candidate>>}
 * Candidate = {
 *   path,          // temp/candidates/<jobId>/frames/f_00042.png  (representative, full-res)
 *   timestamp,     // seconds, float
 *   timecode,      // "MM:SS" via formatTimecode
 *   hash,          // 16-hex dHash of representative
 *   sharpness,     // number (higher = sharper)
 *   span,          // {start,end} of the still window (freeze span or cut window)
 *   groupSize,     // how many sampled frames collapsed into this asset
 *   frameIndexes,  // [41,42,43]
 * }
 */
async function findCandidates(job, videoPath, onProgress) { ... }
```

Stage-by-stage flow (each numbered step maps to a `status` transition on the job):

1. **`status='sampling'`** — `sampleFrames` (Task 2.3). Report progress from ffmpeg's `frame=` stderr lines if we keep `-stats`; otherwise jump 0 → 20% on completion.
2. **`status='filtering'`**
   a. `detectStillSpans` (2.4). Keep only sampled frames inside a span → `inside`.
   b. If `inside` is empty/too small → fallback (2.5), rebuild `inside` from cut timestamps.
   c. **Group consecutively:**
   ```js
   const groups = [];
   for (const f of inside) {
     f.hash = await dhashFromFile(f.path);
     f.sharpness = await sharpnessFromFile(f.path);
     const last = groups[groups.length - 1];
     if (last && hamming(last.hash, f.hash) <= config.PHASH_HAMMING_THRESHOLD) {
       last.members.push(f);
       // keep the best representative by sharpness
       if (f.sharpness > last.representative.sharpness) last.representative = f;
       last.span.end = Math.max(last.span.end, f.span?.end ?? f.timestamp);
     } else {
       groups.push({ representative: f, hash: f.hash, members: [f], span: { start: f.timestamp, end: f.timestamp } });
     }
   }
   ```
   > ⚠️ **Hash-compare-to-representative, not to-previous-frame.** Comparing to the previous frame lets drift creep across 60 frames into a completely different image ("chaining bug"). Compare each frame to the *group's representative hash*. This is the single most likely bug in this phase — write the anti-drift test in 2.6's acceptance list.
   d. Cap: `groups.slice(0, config.MAX_CANDIDATES)`.
   e. Build the `Candidate[]` array sorted by timestamp; recompute `timecode` with `formatTimecode`.
3. Persist on the job: `updateJob(jobId, { candidates, detectionMode, progress: 35 })`.
4. Return candidates.

Perf note: `dhashFromFile` + `sharpnessFromFile` on every in-span frame is fine at SAMPLE_FPS=1 (~600 frames for 10min, most skipped by the span filter; typically <80 frames scored). Compute hash lazily, skip sharpness for non-representatives if profiling shows it matters (measure first).

Acceptance (the anti-drift test is the important one):
- [ ] `slideshow.mp4` fixture → **exactly 8 candidates**, timestamps within ±1.2s of 6,10,14,...,34.
- [ ] Same slide reappears twice non-consecutively → still 2 separate candidates (D3), each with correct hash.
- [ ] **Anti-drift**: a fixture that slowly cross-fades from image A → image B over 20 frames (A to B each hamming ~3) → **must yield 2 groups**, not 1. Build it with `ffmpeg -f lavfi -i color... -filter_complex "xfade=transition=fade:duration=0.8"`.
- [ ] Each candidate's `path` exists, is a full-resolution PNG, and `sharpness` matches a manual re-computation.
- [ ] `groupSize > 1` for multi-frame stills (proves dedupe collapsed them).
- [ ] A 10-min video completes this phase in **< 90s** on a laptop.
- [ ] Re-running candidates on the same job is idempotent (fresh dir each time, no stale `f_*.png` accumulating).

---

## Task 2.7 — Wire into the pipeline + debug endpoint

**Difficulty: Easy–Medium (~1 h)**

`src/routes/extractRoutes.js` — replace the body of the shared post-ingestion stage:

```js
async function runIngested(jobId, videoPath, duration) {
  updateJob(jobId, { videoPath, duration, progress: 10 });
  const candidates = await candidateService.findCandidates(getJob(jobId), videoPath, (pct, stage) => {
    updateJob(jobId, { progress: 10 + Math.round(pct * 0.25), ...(stage && { stage }) });
  });
  // Phase 3 plugs in here. For now, mark done with candidates so we can eyeball them:
  updateJob(jobId, { status: 'done', progress: 100, candidateCount: candidates.length });
}
```

Add the verification endpoint (used only until Phase 4 ships the grid):

```js
// GET /api/jobs/:id/candidates  -> job.candidates, plus base URLs for the images
router.get('/jobs/:id/candidates', (req, res) => { ... });
// express.static for candidate images:
app.use('/candidates', express.static(config.CANDIDATE_DIR));
```

`/candidates/<jobId>/frames/f_00042.png` is how we visually verify. Delete both in Phase 4/5 once the asset grid exists (note it in a code comment `TODO(Phase 5): remove`).

Acceptance:
- [ ] Both entry points (`/api/extract`, `/api/extract/upload`) run through `findCandidates` and end at `status:'done'` with `candidateCount`.
- [ ] `GET /api/jobs/:id` exposes `candidates` (with `path` converted to a `/candidates/...` URL, **never** an absolute filesystem path — don't leak paths).
- [ ] Opening 3–4 candidate URLs in the browser shows real distinct inserted visuals, not junk.
- [ ] The legacy all-frames route is now **unreachable** — either delete it (preferred) or gate behind `?legacy=1`. Document the choice; the zip route must not 404 with a confusing error.

---

## Task 2.8 — Threshold-tuning harness + Phase 2 Definition of Done

**Difficulty: Medium (~2 h)** — this is empirical work; budget real time.

Create `scripts/tune-candidates.js`: for each fixture video × each threshold combo, print a table of results.

```
node scripts/tune-candidates.js
video            fps  freeze_d  hamming  candidates  expected  missed  dupes  time_ms
slideshow.mp4    1    0.8       10       8           8         0       0      4210
slideshow.mp4    1    0.8       20       8           8         0       0      4180
slideshow.mp4    1    3.0       10       3           8         5       0      3900
real_clip.mp4    2    0.8       10       34          ?         ?       2      12800
```

- `missed` = expected slides with no candidate found within ±1.5s.
- `dupes` = pairs of candidates with `hamming <= THRESHOLD/2` **at different indices** (over-splitting).
- Also record `falsePositives` manually (candidate that is ordinary footage) — the number Phase 3's Vision layer will eliminate.

Use it to choose the shipped defaults; write the chosen values and the rationale into `docs/PLAN-phase-2-tuning.md` (or the bottom of this file). Then commit the fixture generator + tuning script so regressions can be re-run later.

Phase 2 Definition of Done:
- [ ] Tasks 2.1–2.7 acceptance all green.
- [ ] `hash.js` and `sharpness.js` are real implementations, not stubs.
- [ ] Fixture scripts + `tune-candidates.js` committed; tuning table recorded with chosen defaults.
- [ ] **The slideshow fixture yields exactly 8 clean candidates** — the single most important number in this phase.
- [ ] `hamming`, `dhashFromFile`, `sharpnessFromFile`, `findCandidates` each have a runnable smoke script under `scripts/` (even without a formal test framework).
- [ ] Zero `fetch`/API calls anywhere in Phase 2 code (grep `anthropic` → no hits under `src/services/candidateService.js`).

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 2.1 | dHash + hamming (`hash.js`) | Medium | 1.5 h |
| 2.2 | Sharpness, resolution-normalized (`sharpness.js`) | Medium | 1–1.5 h |
| 2.3 | ffmpeg fps sampling | Easy–Medium | 45 min |
| 2.4 | `freezedetect` spans + noise-dB config | Medium | 1–1.5 h |
| 2.5 | Scene-cut fallback (Ken Burns case) | Medium | 1 h |
| **2.6** | **Orchestration: group/dedupe/representative/cap** | **HARD** | **3–4 h** |
| 2.7 | Wire pipeline + candidates debug endpoint | Easy–Medium | 1 h |
| 2.8 | Tuning harness + DoD | Medium | 2 h |
| | **Total** | **HARD (core phase)** | **~11–13 h** |

**Top 5 likely bugs:**
1. **Hash chaining drift** — comparing each frame to its *previous* frame instead of the group's representative (2.6 ⚠️). Test it explicitly.
2. **Sharpness not resolution-normalized** → biggest frame always wins, blur never detected (2.2).
3. `freezedetect`'s `n` set too strict (`-60dB`) → misses stills with animated watermarks. Default to `-50dB` and expose the key.
4. **Timestamp off-by-one**: `f_00001.png` is t=0, not t=1 — `(idx-1)/fps` with 1-based filenames, or `idx/fps` with 0-based; mix them and every label is late by one sample.
5. Reading the sampled dir **unsorted** → `f_00010.png` before `f_00002.png` on some filesystems → groups scrambled. Always `.sort()` (padded names sort correctly).

## Copy-paste agent prompt (Phase 2, all tasks)

```
Implement Phase 2 of docs/PLAN.md exactly as specified in docs/PLAN-phase-2.md.
Phases 0-1 are already complete (config keys SAMPLE_FPS/MIN_ASSET_STILL_SEC/PHASH_HAMMING_THRESHOLD/
MAX_CANDIDATES/CANDIDATE_DIR exist; src/utils/ffmpeg.js exports runFfmpeg, formatTimecode,
parseFreezeDetect; hash.js and sharpness.js are stubs).

Implement tasks 2.1 -> 2.8 in order. Do NOT call any LLM/Vision API in this phase — Phase 2 is
pure local ffmpeg + sharp work, and the gate for spending Vision tokens in Phase 3 is a human
eyeballing the candidate images.

Key correctness requirements:
- dHash via sharp: grayscale, resize(9,8,{fit:'fill'}), raw, 64-bit -> 16-char hex string.
  Compare each frame to the GROUP REPRESENTATIVE's hash, never to the previous frame (anti-drift).
- sharpness = variance of 3x3 Laplacian on grayscale, downscaled to WORK_SIZE longest edge
  so ranking is resolution-normalized. Do not skip the resize.
- Sampling timestamp = idx / SAMPLE_FPS (idx is 0-based over sorted f_%05d.png names).
- Still segments from ffmpeg freezedetect n=-50dB:d=MIN_ASSET_STILL_SEC, parsed with the
  existing parseFreezeDetect helper. Add FREEZE_NOISE_DB to config/.env.example.
- If freeze detection finds <2 spans, fall back to scene cuts (select='gt(scene,0.3)' +
  metadata=print); record job.detectionMode = 'freeze' | 'scene_fallback'.
- Group consecutive kept frames by hamming <= PHASH_HAMMING_THRESHOLD, pick sharpest per group,
  cap to MAX_CANDIDATES by earliest timestamp, sort by timestamp, save to job.candidates.
- Replace the body of the shared runIngested() stage with findCandidates(...) so BOTH the
  YouTube and upload paths use it; keep the job reaching status 'done' so the existing routes
  stay functional. Add GET /api/jobs/:id/candidates + static /candidates for visual verification,
  exposing web URLs only (no absolute fs paths in responses).
- Create the slideshow fixture generator script and scripts/tune-candidates.js; run them and
  report the measured table (expected 8 candidates from the fixture).

Files to create: src/services/candidateService.js, scripts/make_fixtures.sh, scripts/tune-candidates.js.
Files to modify: src/utils/hash.js, src/utils/sharpness.js, src/utils/ffmpeg.js (add parseSceneCuts),
src/routes/extractRoutes.js, src/config.js (add FREEZE_NOISE_DB, FALLBACK_TO_SCENE_CUTS,
SCENE_THRESHOLD, MAX_SCENE_CANDIDATES), .env.example, src/server.js (static /candidates).
```
