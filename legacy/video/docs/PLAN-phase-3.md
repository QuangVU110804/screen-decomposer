# Phase 3 — Detailed Plan: Claude Vision (Confirm + Label)

> Parent: [PLAN.md](./PLAN.md). Prereq: [Phase 2](./PLAN-phase-2.md) done and **eyeballed** —
> don't start this phase until the candidate images actually look like real assets.
> **Difficulty: Medium-Hard.** API plumbing is easy; getting reliable structured output,
> sane batching, and graceful partial failure right is the real work.
> Definition of done: `job.assets` contains only real confirmed inserts, each with a
> readable 2–5 word label, for the cost of a handful of API calls per video.

**Design decisions locked:**

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Tool-forced JSON** (`tool_choice: {type:'tool', name:'report_assets'}`), not prose parsing | Zero parsing ambiguity; Claude must fill a schema, no markdown fencing to strip. |
| D2 | Batch `VISION_BATCH_SIZE` (default 5) images per request | Balances context size vs. call count/cost; 30 candidates → 6 calls. |
| D3 | `temperature: 0` | This is a classification task, not creative — determinism matters for the "not an asset" filter. |
| D4 | Downscale + JPEG-encode images **before** sending to Vision (never send the full-res PNG) | Vision doesn't need 4K fidelity to classify; smaller payload = faster + cheaper. Final assets still come from the full-res candidate file in Phase 4. |
| D5 | Partial-failure tolerant: one bad batch → skip it, keep the rest | A transient 500 on batch 4 of 6 shouldn't fail the whole job. |
| D6 | `ANTHROPIC_API_KEY` missing → fail the job with an actionable message, not a stack trace | This is the one hard external dependency in the whole pipeline. |

---

## Task 3.1 — Install `@anthropic-ai/sdk`, add env keys

**Difficulty: Easy (~15 min)**

1. `npm install @anthropic-ai/sdk`
2. Confirm `config.js` already has (from Phase 0): `ANTHROPIC_API_KEY`, `VISION_MODEL`, `VISION_BATCH_SIZE`, `CLAUDE_TIMEOUT_MS`. Add if missing:
```
VISION_MAX_RETRIES=3
VISION_JPEG_QUALITY=70
VISION_MAX_EDGE_PX=1024
```
3. In `.env.example`, document `ANTHROPIC_API_KEY` with a comment pointing to console.anthropic.com.

Acceptance:
- [ ] `node -e "require('@anthropic-ai/sdk')"` OK.
- [ ] Missing key at boot → warning already exists from Phase 0; verify it still fires.

---

## Task 3.2 — Prepare-image helper: downscale candidate → base64 JPEG

**Difficulty: Easy (~30 min)**

```js
// src/services/visionService.js (or src/utils/imagePrep.js)
const sharp = require('sharp');

async function prepareImageForVision(candidatePath) {
  const buf = await sharp(candidatePath)
    .resize({ width: config.VISION_MAX_EDGE_PX, height: config.VISION_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: config.VISION_JPEG_QUALITY })
    .toBuffer();
  return { base64: buf.toString('base64'), mediaType: 'image/jpeg', bytes: buf.length };
}
```

Acceptance:
- [ ] A 4K candidate → output JPEG under ~200KB typically (log `bytes`, not a hard assertion — content-dependent).
- [ ] Never enlarges a small candidate (`withoutEnlargement: true`).

---

## Task 3.3 — Prompt design (system + per-batch user message)

**Difficulty: Medium (~1 h)** — wording quality directly drives false-positive/negative rate; expect to iterate.

**System prompt:**

```
You analyze still frames sampled from a video. Your job is to identify which frames show
an INSERTED VISUAL ASSET — a photo, product image, screenshot, chart, diagram, slide, or
graphic that was deliberately placed into the video as distinct content — as opposed to
ordinary footage of the video itself (a person talking, a webcam feed, a screen recording
of normal browsing/scrolling with no distinct still shown, blank/transition frames, or
plain background).

For each frame you are given:
- If it IS an inserted asset: set isAsset=true, give a short human label (2-5 words,
  e.g. "iPhone product photo", "Revenue chart", "Login screenshot") and a one-sentence
  description of what's shown.
- If it is NOT (ordinary footage, blur, transition, blank/solid color, webcam) set
  isAsset=false with an empty label.

Be conservative: a frame of a person's face, a plain background, or generic B-roll is
NOT an asset even if it is visually distinct from surrounding frames. Only flag content
that looks like it was deliberately inserted as a discrete visual (a still image, a chart,
a document, a UI screenshot).
```

**Per-batch user message:** interleave a text marker before each image so refs are unambiguous:

```js
const content = [];
batch.forEach((cand, i) => {
  content.push({ type: 'text', text: `Frame ${i} — timestamp ${cand.timecode}` });
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: cand._b64 } });
});
content.push({ type: 'text', text: `Classify all ${batch.length} frames above using report_assets. Use "ref" equal to the Frame number (0-based) shown before each image.` });
```

Acceptance:
- [ ] Manual smoke test: send the 8 slideshow-fixture candidates (solid colors) — expect Claude to correctly call them **not** assets (they're solid colors, not real content) OR label them minimally; the important check is the **tool call shape is valid JSON matching schema**, not the semantic verdict on synthetic fixtures.
- [ ] Send 3 obviously-real asset screenshots (grab from any real slideshow-style YouTube video you have rights to test with) + 2 talking-head frames → correct `isAsset` split.

---

## Task 3.4 — `report_assets` tool schema + forced tool call

**Difficulty: Medium (~1 h)**

```js
const REPORT_ASSETS_TOOL = {
  name: 'report_assets',
  description: 'Report classification results for every frame in this batch.',
  input_schema: {
    type: 'object',
    properties: {
      assets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'integer', description: '0-based frame index within this batch' },
            isAsset: { type: 'boolean' },
            label: { type: 'string', description: '2-5 word human label; empty string if isAsset=false' },
            description: { type: 'string', description: 'one sentence; empty string if isAsset=false' },
            confidence: { type: 'number', description: '0 to 1' },
          },
          required: ['ref', 'isAsset', 'label', 'description', 'confidence'],
        },
      },
    },
    required: ['assets'],
  },
};

async function classifyBatch(batch) {
  const message = await client.messages.create({
    model: config.VISION_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [REPORT_ASSETS_TOOL],
    tool_choice: { type: 'tool', name: 'report_assets' },
    messages: [{ role: 'user', content: buildContent(batch) }],
  }, { timeout: config.CLAUDE_TIMEOUT_MS });

  const toolUse = message.content.find(b => b.type === 'tool_use' && b.name === 'report_assets');
  if (!toolUse) throw new Error('Claude did not return a report_assets tool call');
  return toolUse.input.assets; // [{ref,isAsset,label,description,confidence}]
}
```

Rules:
- **Validate the response shape** before trusting it: every `ref` must be `0 <= ref < batch.length` and unique-ish (Claude occasionally skips one — treat missing refs as `isAsset:false`, don't crash).
- If `assets.length !== batch.length`, log a warning but proceed with what's present (defensive, not fatal).

Acceptance:
- [ ] Malformed/missing ref in a manually-crafted mock response → mapped safely, no throw, missing frames treated as non-assets.
- [ ] `tool_choice` forcing works — a raw prose reply never reaches the parser (SDK throws before we'd see prose, since we require the tool block to exist).

---

## Task 3.5 — Retry/backoff wrapper + batch orchestration

**Difficulty: Medium (~1.5 h)**

```js
async function withRetry(fn, { retries = config.VISION_MAX_RETRIES, baseMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      // Covers rate limits/server errors (have err.status) AND plain network failures
      // (ECONNRESET/ENOTFOUND/etc — these never have err.status, so checking status alone
      // would silently skip retrying the most common transient case: a dropped connection).
      const retryable = err.status === 429
        || (err.status >= 500 && err.status < 600)
        || err.name === 'APIConnectionTimeoutError'
        || err.name === 'APIConnectionError'
        || !err.status;
      if (!retryable || attempt === retries) throw err;
      const delay = baseMs * 2 ** attempt + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function classifyCandidates(candidates, onProgress) {
  const prepared = await Promise.all(candidates.map(async c => ({ ...c, _b64: (await prepareImageForVision(c.path)).base64 })));
  const batches = chunk(prepared, config.VISION_BATCH_SIZE);
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      const verdicts = await withRetry(() => classifyBatch(batches[i]));
      verdicts.forEach(v => {
        const cand = batches[i][v.ref];
        if (cand) results.push({ candidate: cand, ...v });
      });
    } catch (err) {
      console.warn(`Vision batch ${i + 1}/${batches.length} failed after retries: ${err.message}`);
      // skip batch; its candidates simply produce no assets (D5)
    }
    onProgress((i + 1) / batches.length);
  }
  return results.filter(r => r.isAsset);
}
```

Acceptance:
- [ ] Simulate a 429 on batch 2 of 4 (mock the client to throw once) → batch 2 retried and succeeds on 2nd attempt.
- [ ] Simulate permanent failure on batch 3 of 4 → job still completes with batches 1,2,4 results; no unhandled rejection.
- [ ] All `sharp`-loaded base64 buffers happen **once**, up front (`Promise.all`), not re-read per retry — verify with a log count.

---

## Task 3.6 — Wire into the pipeline; progress mapping; cost logging

**Difficulty: Easy–Medium (~1 h)**

`runIngested` extends:

```js
async function runIngested(jobId, videoPath, duration) {
  updateJob(jobId, { videoPath, duration, progress: 10 });
  const candidates = await candidateService.findCandidates(getJob(jobId), videoPath,
    pct => updateJob(jobId, { progress: 10 + Math.round(pct * 25) }));   // 10-35%

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('Thiếu ANTHROPIC_API_KEY — không thể phân tích ảnh bằng Vision. Thêm key vào .env.');
  }

  updateJob(jobId, { status: 'analyzing', progress: 35 });
  const verdicts = await visionService.classifyCandidates(candidates,
    frac => updateJob(jobId, { progress: 35 + Math.round(frac * 55) }));  // 35-90%

  const assets = verdicts.map(v => ({
    label: v.label, description: v.description, confidence: v.confidence,
    timestamp: v.candidate.timestamp, timecode: v.candidate.timecode,
    framePath: v.candidate.path,   // Phase 4 finalizes into asset_00N.png
  }));
  updateJob(jobId, { assets, progress: 90 });

  console.log(`[job ${jobId}] vision: ${candidates.length} candidates -> ${assets.length} confirmed assets, ` +
    `${Math.ceil(candidates.length / config.VISION_BATCH_SIZE)} API calls`);
}
```

Acceptance:
- [ ] Progress bar (via polling `GET /api/jobs/:id`) visibly moves 10→35→(35..90 in steps)→90 across a real run.
- [ ] Missing API key → job `failed` with the exact Vietnamese message above, not a raw SDK stack trace.
- [ ] Console log line shows a sane call count (e.g. 30 candidates / batch 5 = 6 calls).

---

## Task 3.7 — Real-video validation + Phase 3 Definition of Done

**Difficulty: Medium (~1.5–2 h)** — needs a real test video with real inserted assets (a product-review or tutorial-style video with slides/screenshots), respecting YouTube ToS as noted in the README (public video, dev/research use only).

Checklist:
1. Run a ~5 min real video with 4-8 known inserted images/screenshots through the full pipeline.
2. Compare `job.assets` against your own manual count of "distinct inserted visuals" in the video.
3. Tune `MIN_ASSET_STILL_SEC` / `PHASH_HAMMING_THRESHOLD` (Phase 2) or the system prompt (this phase) if precision/recall is off — this is expected, budget iteration.

Phase 3 Definition of Done:
- [ ] Tasks 3.1–3.6 acceptance all green.
- [ ] On the real test video: **no false positives from ordinary talking-head footage**, and **every clearly-inserted still is found** (recall matters more than precision at this stage — Phase 6's UI lets a human glance and ignore junk; a missed asset is unrecoverable without re-running).
- [ ] Total API calls for a 10-min video stays under ~15 (bounded by `MAX_CANDIDATES` from Phase 2 / `VISION_BATCH_SIZE`).
- [ ] `job.assets[].label` reads like the PLAN.md example ("iPhone image", "Revenue chart"), not filenames or generic "Image".

---

## Summary table

| Task | Description | Difficulty | Est. |
|------|-------------|-----------|------|
| 3.1 | Install SDK, env keys | Easy | 15 min |
| 3.2 | Downscale-to-base64 helper | Easy | 30 min |
| 3.3 | Prompt design (system + user) | Medium | 1 h |
| 3.4 | Tool schema + forced tool_choice | Medium | 1 h |
| 3.5 | Retry/backoff + batch orchestration | Medium | 1.5 h |
| 3.6 | Pipeline wiring + progress + cost log | Easy–Medium | 1 h |
| 3.7 | Real-video validation + DoD | Medium | 1.5–2 h |
| | **Total** | **Medium-Hard** | **~7–8 h** |

**Biggest risk:** prompt quality is not a one-shot — expect to run task 3.7 more than once and adjust the system prompt's conservatism language. Budget the iteration time, don't treat the first pass as final.

## Copy-paste agent prompt (Phase 3, all tasks)

```
Implement Phase 3 of docs/PLAN.md exactly as specified in docs/PLAN-phase-3.md.
Phase 2 is complete: job.candidates exists with {path,timestamp,timecode,hash,sharpness}.

Implement tasks 3.1 -> 3.6 (task 3.7 is manual validation you'll report back on):
1. npm install @anthropic-ai/sdk. Add VISION_MAX_RETRIES, VISION_JPEG_QUALITY,
   VISION_MAX_EDGE_PX to config.js/.env.example.
2. Create src/services/visionService.js:
   - prepareImageForVision(path): sharp resize(inside, VISION_MAX_EDGE_PX) + jpeg(quality) -> base64.
   - Use the exact system prompt and report_assets tool schema from PLAN-phase-3.md sections
     3.3/3.4 (tool_choice forced, temperature 0). Validate refs defensively (missing/out-of-range
     ref -> treated as not-an-asset, never throws).
   - withRetry: exponential backoff on 429/5xx/timeout, max VISION_MAX_RETRIES, otherwise
     skip the batch (log warning) and continue with remaining batches — partial results are OK.
   - classifyCandidates(candidates, onProgress): prepares all images up front (Promise.all,
     read/encode once), chunks into VISION_BATCH_SIZE batches, classifies each, reports
     progress as batches complete, returns only isAsset===true results with full candidate ref.
3. Wire into runIngested in extractRoutes.js: status 'analyzing' at progress 35, mapping
   Vision progress to 35-90%, then build job.assets from verdicts (label, description,
   confidence, timestamp, timecode, framePath=candidate.path). If ANTHROPIC_API_KEY is empty,
   fail the job immediately with the Vietnamese message in PLAN-phase-3.md task 3.6 (don't
   attempt the call). Log a one-line cost summary (candidates -> assets, API call count).

Do not touch Phase 2's candidateService.js internals. Do not implement Phase 4's file
finalization (asset_00N.png naming) — assets[].framePath still points at the raw candidate
file in temp/candidates for now.
```
