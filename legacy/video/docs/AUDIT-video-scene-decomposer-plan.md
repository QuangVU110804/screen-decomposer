# Video Scene Decomposer — PLAN completion audit

Date: 2026-09-01

This audit maps `PLAN-video-scene-decomposer-reframing.md` to authoritative repository evidence. It separates implementation completion from release claims that require a human editor or paid/live production providers.

Status vocabulary:

- **Implemented + verified**: current source and automated/runtime evidence directly cover the requirement.
- **Implemented; external validation pending**: the workflow, metric or adapter exists, but the PLAN gate requires real reviewed data or a production provider.
- **Intentionally deferred**: explicitly outside the MVP in the PLAN.

## Architecture and canonical checklist

| PLAN checklist | Status | Authoritative evidence |
|---|---|---|
| Job/manifest/API use scene-centered schema v2 | Implemented + verified | `decomposerSchema`, `pipelineService`, `packageService`, v2 serializers/routes; schema, API, package and restart tests |
| Scene is the canonical downstream partition | Implemented + verified | one `sceneDetectionService` result feeds keyframes, analysis, association, extraction, recovery, validation, dedupe and packaging |
| Every scene has diverse keyframes and selection reasons | Implemented + verified | proxy feature sampling, safe-frame preference, diversity selection, source-resolution extraction and schema validation |
| Scene analyzer returns multi-keyframe observations | Implemented + verified | stable keyframe refs, bbox/corners, visibility, occlusion, motion and structured tool schema |
| Direct crops for image/screenshot/text/graphic | Implemented + verified | controlled padding, best observation, quadrilateral rectification, OCR fallback and provenance tests |
| RGBA segmentation for person/character | Implemented + verified | raw/refined masks, alpha output, checkerboard preview, mask IoU and boundary-F1 tests |
| Background recovery exposes reconstructed regions | Implemented + verified | temporal recovery, optional inpainting, reconstructed mask, source/generated ratios and provider metadata |
| Tracks/occurrences and cross-scene dedupe | Implemented + verified | semantic/spatial/temporal association; dHash, chroma, mask, dimensions and embedding-safe dedupe; repeated-identity benchmark |
| Quality is independent of AI confidence | Implemented + verified | mode/type-specific explainable components, file validation, usable/review/failed states and rank-correlation reporting |
| UI starts from scene timeline and selected-scene asset gallery | Implemented + verified | scene timeline/detail/keyframes, selected-scene scope by default, type/mode/quality filters and safe rendering tests |
| Scene/full packs preserve provenance | Implemented + verified | atomic staging, per-scene metadata, occurrences, masks, notices, scoped ZIP tests |
| Legacy results remain explicitly separate | Implemented + verified | schema/version adapter, `legacy-frame` labels, compatibility routes and deprecation document |
| Evaluation measures extraction quality and editor utility | Implemented; external validation pending | boundary, element, bbox, mask, tracking/dedupe, quality calibration and editor-utility metrics exist; human ratings remain pending |
| README/runtime/config match code | Implemented + verified | Node runtime, `.env.example`, central registry and `check:config` |
| Source discovery stays outside MVP | Intentionally deferred | no reverse-search endpoint/service; README and UI make no provenance/license claim |

## Phase-by-phase gates

### Phase 0 — Evaluation foundation

- ADRs define canonical scenes, provider boundaries and provenance/quality.
- Synthetic CC0 fixture metadata covers each committed scene/element category with positive and hard-negative references.
- Ground truth contains scene boundaries, element identities/bboxes, quality thresholds and a repeated cross-scene identity.
- Evaluation is independent of the UI.
- Deterministic legacy baseline measures 3 candidates, 3 full-frame outputs, one mock Vision call, 548,117 artifact bytes and 1,631 ms on the current fixture.
- Provider matrix covers HTTP production adapters and deterministic local fallback paths.

External gate still open: `reviewStatus` remains `pending-human-editor-review`; mixed-transition semantics and annotations have not been signed off by a human editor.

### Phase 1 — Domain, storage and compatibility

- Express routes only create/enqueue/serialize; orchestration is in the pipeline service.
- Schema v2 validates partitions, keyframes, elements, tracks, assets, occurrences and mode-specific provenance.
- Job JSON persists in SQLite; artifacts stay on disk.
- v1 is not reinterpreted as decomposer output.
- Source is retained for re-analysis until retention cleanup.
- Re-analysis is deterministic on success and restores the previous valid pack as `PARTIAL` on failure.

Gate evidence: schema rejection, persistence/restart, path-safe serialization, cleanup, package and retry tests.

### Phase 2 — Canonical scenes

- Hard cuts, lower-threshold composition evidence and black/fade intervals feed one detector.
- Canonical partition covers `[0,duration)` without gaps/overlap.
- Micro-scenes merge with reasons; long scenes split without dropping time.
- Sanitized raw/merged boundary evidence is retained in metrics.
- Scene previews share canonical IDs/ranges.

Gate evidence: partition tests and synthetic detector F1 = 1.0. Human-reviewed fade/dissolve/scroll benchmark remains an external validation gate.

### Phase 3 — Keyframes

- Proxy sampling uses sharpness, motion/composition difference, brightness/contrast, black-frame and transition penalties.
- Safe non-transition frames are preferred when available.
- Diversity selection avoids near-identical keyframes.
- Canonical files are extracted again at source resolution.
- Metrics report keyframe count, actual selection latency, estimated analysis pixels and selected black/transition counts.

Gate evidence: synthetic end-to-end selection has zero selected black/transition frames. Editor-reviewed element coverage versus a single-frame baseline remains pending.

### Phase 4 — Scene understanding

- Multi-image scene contract includes all MVP editor-centric types, including person/background.
- Observations use stable refs and validated normalized localization.
- Provider retry/failure is isolated per scene.
- Internal audit records provider/model, latency, token usage, bytes and pixels without exposing request IDs or secrets publicly.
- Per-scene Vision byte/pixel hard caps prevent uncontrolled requests.

External gate still open: live Anthropic precision/recall and bbox IoU on reviewed ground truth.

### Phase 5 — Direct extraction

- Best observation scoring uses visibility, occlusion, area and sharpness.
- Direct assets use source pixels only and record crop/original-resolution provenance.
- Text records OCR content/confidence/style with a non-fatal fallback.
- Full frames are preview/evidence only.

Gate evidence: crop, perspective, OCR fallback, schema provenance and end-to-end tests.

### Phase 6 — Segmentation/matting

- Local and HTTP/custom adapters return masks and provider metadata.
- Raw and refined masks are retained.
- Mask validation catches empty/full masks and reports clipped-boundary/edge signals.
- Provider cache is keyed by source frame, crop, element and provider version, and survives asset-directory rebuild.
- Automated synthetic mask IoU is above 0.90 and boundary F1 is above 0.85.

External gate still open: production-provider visual review for hair, glow, shadows, semi-transparency and motion blur.

### Phase 7 — Background recovery

- Foreground masks form the recovery region.
- Static-composition temporal recovery is preferred over generation.
- Missing-area caps refuse unsafe reconstruction.
- Generated/inferred output is always labeled `RECONSTRUCTED` with mask/provider/ratios.
- Inpainting results have a versioned persistent cache.

External gate still open: editor artifact review and production inpainting temporal-consistency review.

### Phase 8 — Tracking/dedupe

- Scene observations are associated into tracks using type, semantics, bbox and temporal adjacency.
- Asset dedupe combines visual, chroma, shape, dimension, semantic and track evidence conservatively.
- Occurrences replace duplicate outputs.
- Evaluation reports repeated-identity ID switches, fragmentation, duplicate-kept rate and false-merge rate.

Gate evidence: the main synthetic evaluation now contains one identity repeated across two scenes with zero ID switches and one deduped identity.

### Phase 9 — Quality and validation

- Explainable quality vector is calibrated by type/mode.
- Primary file integrity, dimension, alpha, masks and reconstruction metadata are validated before packaging.
- Failed assets remain diagnostic and are hidden by default.
- Editor feedback aggregates partial events correctly and reports Spearman correlation between quality and utility/download/artifact ratings.

External gate still open: enough human ratings to establish real ranking correlation and utility thresholds.

### Phase 10 — API, UI and packs

- All planned v2 job/scene/asset/media/download endpoints exist.
- UI supports scene navigation, evidence, selected-scene asset scope, global scope, filters, text mode labels, masks and downloads.
- Feedback uses a stable pseudonymous browser reviewer ID.
- Public payloads/manifest omit filesystem paths, secrets and raw provider responses.
- Copyright/reuse notice is present.

Gate evidence: API media/ZIP tests, safe serializer tests and UI runtime/static tests.

### Phase 11 — Hardening and release

- Upload and mocked YouTube paths both run the shared v2 pipeline.
- Provider malformed/failure/retry paths, corrupt media, restart, rate limit, auth, cleanup and allowlist behavior are tested.
- Resource budgets now cover scenes, keyframes, Vision bytes/pixels, segmentation calls, inpaint area, job disk and runtime.
- Structured stage/scene logs include IDs, provider/model, latency, cost counters and failure codes.
- Editor acceptance refuses a release claim unless every source is explicitly human-reviewed.
- Live benchmark defaults to dry-run and requires `--live --confirm-api-cost`; no paid call is made automatically.

## Current automated evidence

- Full serial suite: 84/84 current test cases passed on the 2026-09-01 rerun; see the latest implementation report and `npm.cmd run test:serial`.
- Config registry: all 56 documented keys pass `npm.cmd run check:config`.
- Standalone scene evaluator: three canonical scenes over 0–12 seconds, boundary precision/recall/F1 = 1.0 and the configured gate passed.
- Synthetic extraction evaluation: boundary, element, bbox, tracking and dedupe gates pass.
- End-to-end mock-provider MVP: all seven committed element families and all three successful extraction modes.
- URL and upload share the scene-first pipeline.
- Failed scene retry preserves the previous valid package and produces `PARTIAL`.
- Runtime smoke on port 3191 returned HTTP 200 for health, public v2 config and the scene-first UI, then stopped the spawned server cleanly.
- The 7 generated JSON reports/manifests currently present under `test-results/` and `temp/` contain no provider keys, private-key material or absolute filesystem paths.

## Release gates that repository automation cannot close

1. Human editor approval of ground-truth semantics and annotations.
2. Human utility ratings meeting the published useful/download-intent thresholds.
3. Live Anthropic element/bbox benchmark on the reviewed set.
4. Production segmentation visual review.
5. Production inpainting/background artifact review.
6. Published live latency/API-cost results with explicitly approved provider spend.

Until those six items are complete, the engineering conversion is implemented but the MVP production release gate is deliberately not claimed.
