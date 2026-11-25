# Video Scene Decomposer implementation report

Date: 2026-09-01

## Outcome

New submissions now run a scene-centered schema v2 pipeline. The frame/candidate pipeline remains only as a read/run compatibility implementation for legacy jobs.

The engineering implementation is complete enough to run the synthetic MVP end to end, but the production release gate is not yet claimed: human editor review and paid/live provider benchmarking remain external validation work.

## Requirement audit

| Plan checklist | Current evidence |
|---|---|
| Job/manifest/API use scene-centered schema v2 | `decomposerSchema`, `pipelineService`, v2 routes and public manifest; schema/API tests pass |
| Scene is the canonical downstream partition | pipeline starts with `sceneDetectionService`; every downstream service receives `job.scenes`; synthetic detector F1 is 1.0 |
| Diverse keyframes with selection reasons | proxy sampling, sharpness/composition/black/transition features, diversity selection and source-resolution extraction |
| Multi-keyframe element observations | structured scene analyzer contract with stable refs, bbox/corners, visibility, occlusion and motion |
| Direct crop for image/screenshot/text/graphic | direct extraction, optional quadrilateral rectification and OCR metadata/fallback |
| RGBA segmentation for person/character | HTTP adapter plus local matte; automated alpha validation and synthetic mask IoU gate |
| Transparent background recovery provenance | temporal recovery first, optional inpainting, recovery mask, source/generated ratios and provider metadata |
| Tracks/occurrences and cross-scene dedupe | semantic/spatial/temporal tracks; dHash + chroma + mask + embedding-safe asset dedupe |
| Quality independent from AI confidence | explainable quality components and type/mode-specific weights; validator controls usable/review/failed |
| Scene-first UI | timeline, selected scene, preview/keyframes, filters, mode/quality labels, mask links and download controls |
| Scene/full packs with provenance | atomic scene directories, scene metadata, v2 manifest, scoped scene ZIP and full ZIP |
| Legacy compatibility/deprecation | schema adapter, legacy serializers/routes/UI label and `DEPRECATION-v1.md` |
| Evaluation measures extraction quality | boundary F1, element precision/recall, bbox IoU, mask IoU/boundary F1, tracking ID switches, dedupe rates, quality calibration and strict editor utility gates |
| README/runtime/config match code | Node >=22.13, config registry check, v2 API/provider/artifact documentation |
| Source discovery remains outside MVP | no reverse-search/source-discovery implementation or endpoint exists |

## Automated evidence

- Full sequential regression suite rerun on 2026-09-01: 84/84 current test cases passed.
- Config registry verification: all 56 documented keys match the central registry.
- Synthetic scene detector: boundaries at 4.0 s and 8.0 s, precision/recall/F1 = 1.0 at 250 ms tolerance.
- Synthetic local segmentation: meaningful RGBA alpha and mask IoU > 0.90 for the deterministic foreground fixture.
- Synthetic background recovery: recovery area ratio matches the annotated mask area within 0.01.
- End-to-end MVP fixture: `person`, `character`, `background`, `image`, `screenshot`, `text`, `graphic`; modes `DIRECT`, `SEGMENTED`, `RECONSTRUCTED`; 7 usable assets and no pipeline failure.
- Isolated scene failure produces `PARTIAL`; re-analyze rebuilds deterministic IDs and returns `DONE`.
- Runtime smoke test on port 3191: `/health`, `/api/v2/config` and scene-first HTML all returned HTTP 200; the public config reported `schemaVersion: 2`, and the page contained the scene timeline and selected-scene controls. The spawned server was stopped and the port was confirmed closed afterward.
- Generated JSON safety scan: all 7 current files under `test-results/` and `temp/` were checked without finding provider keys, private-key material or absolute filesystem paths.
- Editor acceptance support validates reviewer/rating input, aggregates the latest reviewer/asset decision by type and extraction mode, and applies the configured useful/download-intent thresholds.
- Live-provider benchmark dry-run on 2026-09-01 planned 3 scenes, at most 9 keyframes, 8 MiB prepared image bytes and 3 API requests; it made 0 API requests and refused to claim reviewed results while ground truth remained pending.
- Deterministic legacy baseline: 3 candidates, 3 full-frame assets, 1 mock Vision call, 548,117 artifact bytes and 1,631 ms.
- Repeated synthetic logo identity across two scenes: 2/2 matched occurrences, 0 ID switches, 0 duplicate-kept rate and 0 false-merge rate.
- Provider caches survive asset-directory rebuild and are invalidated by provider version changes.
- Re-analysis failure restores the previous valid result/package and records a scene-scoped `PARTIAL` failure.
- Hard budgets cover Vision bytes/pixels, job disk and pipeline runtime in addition to existing scene/keyframe/provider-call limits.

## Validation commands

```powershell
npm.cmd run test:serial
npm.cmd run check:config
npm.cmd run evaluate:scenes
npm.cmd run evaluate
npm.cmd run baseline:legacy
npm.cmd run acceptance:summary -- <editor-review.json> --output test-results/editor-acceptance/report.json
npm.cmd run benchmark:providers -- --dry-run
```

The live benchmark path additionally requires both `--live` and `--confirm-api-cost`. It records token usage, latency and optional user-priced cost estimates without writing API keys, raw requests or provider request IDs.

## External gates still pending

These cannot be honestly proven by repository automation alone:

1. Human editor review of ground-truth semantics and actual “would download/reuse” utility.
2. Live Anthropic element precision/recall and bbox IoU on the reviewed benchmark.
3. Production segmentation provider review for hair, glow, shadow, semi-transparency and motion blur.
4. Production inpainting review for seams, temporal consistency and “plausible but wrong” content.
5. Published latency/API-cost budget from live provider runs.

`test/fixtures/decomposer/ground-truth.json` therefore records `pending-human-editor-review`. The guarded tooling is ready, but no live Anthropic or other paid provider call was made in this implementation pass.

The requirement-by-requirement status is recorded in `docs/AUDIT-video-scene-decomposer-plan.md`.
