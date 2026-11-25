# Video Scene Decomposer baseline

Date: 2026-09-01

The pre-reframing production route used freeze/static-frame candidates, dHash grouping, a single-frame inserted-asset classifier and full-frame PNG output. Its structural baseline was:

- canonical scene partition: unavailable;
- scene boundary precision/recall: not measurable from job output;
- multi-keyframe element recall: unavailable;
- bbox/mask quality: unavailable;
- reusable output containing full-frame pixels: 100%;
- cross-scene asset identity: unavailable;
- quality score independent of Vision confidence: unavailable.

The benchmark contract is stored in `test/fixtures/decomposer/ground-truth.json`. It uses synthetic CC0 scenarios so every MVP element type has a positive and a hard-negative case. Run:

```powershell
npm.cmd run baseline:legacy
npm.cmd run evaluate
```

Initial MVP gates are boundary F1 ≥ 0.85 at 250 ms tolerance, element precision/recall ≥ 0.75, bbox IoU ≥ 0.5, duplicate-kept rate ≤ 0.10 and false-merge rate ≤ 0.03. Visual segmentation/reconstruction gates require editor review in addition to automated metrics.

## Deterministic legacy measurement

On 2026-09-01, the retained frame-centered compatibility pipeline was run on the synthetic decomposer fixture with deterministic mock Vision:

- 3 candidates;
- 3 exported assets;
- full-frame output ratio: 1.0;
- 1 Vision-shaped mock request containing 3 images;
- 548,117 bytes of candidate/final artifacts;
- 1,631 ms elapsed on the current Windows workspace;
- no paid provider request.

The sanitized machine-readable result is written to `test-results/baselines/legacy-frame.json`. Scene, element, bbox, mask and cross-scene identity metrics remain structurally unavailable from the legacy job model, which is the baseline limitation the v2 architecture addresses.

## Current foundation check

On 2026-09-01, `node scripts/evaluate-scene-detector.js` detected the two synthetic hard-cut boundaries at exactly 4.0 s and 8.0 s: precision 1.0, recall 1.0 and F1 1.0 at the 250 ms tolerance. This is a deterministic foundation check, not a substitute for the pending human-reviewed mixed transition dataset.
