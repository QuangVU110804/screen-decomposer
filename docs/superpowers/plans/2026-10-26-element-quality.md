# Element quality repair implementation plan

> Execute inline with Superpowers executing-plans and test-driven-development. This repairs the approved automatic local workflow using the user's concrete reference; no API/model/backend change or new cloud dependency.

**Goal:** prefer whole visible objects over anatomy fragments, recover disconnected graphic parts, and export text alpha when supported by image evidence.
**Architecture:** keep MobileSAM/RapidOCR CPU; add bounded postprocessing after mask discovery and text alpha estimation within OCR polygons. Source pixels are preserved; no inpainting. Ambiguous text falls back to an explicit crop. Existing job/checkpoint/cancel behavior remains valid.
**Spec:** user request 26/10 + approved local-image-elements design. Work in place (no Git metadata).

## Global constraints

Local/offline, no API key, no extra model download. Keep two CPU threads, bounded candidates and existing time/disk caps. No hard-coded yellow, sun coordinates or anime identity in production code. Keep holes between graphic parts transparent. Preserve independent overlays even if their bbox is contained by a character.

## Review focus

- Same-colored but unrelated neighbors must not be joined solely by color.
- A complete mask must be preferred even when discovered after its partial masks.
- A text alpha mask must not silently include a textured background; uncertain crops remain labeled.
- Refined overlays must not be duplicated inside the exported underlying character.
- Final consolidation must not invalidate files referenced by an interrupted checkpoint.

### 1. Reproduce and add regression tests

- [x] Baseline inference on provided 1200×675 reference. Inspect original masks and annotate ray/character/negative-gap landmarks independently of implementation.
- [x] Add failing tests for containment consolidation, independent nested graphic, late whole-object mask, disconnected graphic with separate blue/yellow variants, text on flat/gradient versus ambiguous background, and source alpha preservation.

### 2. Geometry and graphic refinement

Files: workers/regions.py; workers/engine.py; test/python/test_regions.py.
Interfaces: consolidate_candidates(candidates, rgb) -> {candidates, stats}; assemble_graphic(rgb, mask) -> (mask, metadata).
- [x] Use global containment/IoU and coverage checks, preserving separate overlays; suppress nested body parts only when a reliable containing object exists.
- [x] Infer a compact chromatic palette from a seed, find nearby connected components, accept only small radial/coherent satellites, retain gaps. Work on the proxy and keep masks bounded.
- [x] Subtract verified multipart overlays from containing composite masks without generating hidden pixels. Checkpoint final exports atomically; clean only unpublished artifacts.

### 3. Text alpha and UI semantics

Files: workers/text_alpha.py; workers/masks.py; src/web/modules/element-types.mjs; app.js; gallery.js; Python/Node tests.
Interfaces: estimate_text_alpha(rgb, polygon) -> {alpha, confidence, method}|None.
- [x] Estimate smooth background from padding/border, reject unstable backgrounds, isolate contrasting glyph strokes with soft alpha. Keep polygon/source-alpha constraints; return crop fallback on ambiguity. Outline/shadow recovery remains limited.
- [x] Keep masked text in the text filter by semantic type, display alpha/crop distinction and refinement metadata accurately.

### 4. Verify and deliver

- [x] Run Python + Node regression, actual CPU inference on reference and text image, independent landmark check (all sun-ray centers retained, gaps removed, character body/limbs retained in one primary mask).
- [x] Inspect PNGs on contrasting backgrounds and UI. Verify cache invalidation for new postprocessing modules, restart only this app and expose new results.
- [x] Fresh code review, fix important findings, update report with actual quality limits/timings and example artifacts.

Verified: 15 Node + 19 Python tests; final reference run `anime-reference-fast-1792997126323`, 3 elements, 11/11 ray landmarks and 6/6 body landmarks. Live app job `d62c834a-98cd-49cf-93c1-3d430940167f`; ZIP CRC valid. See `docs/REPORT-element-quality-2026-10-26.md` for measured limits and artifacts.
