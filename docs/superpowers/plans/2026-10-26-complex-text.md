# Complex text alpha repair plan

> Implement inline with Superpowers executing-plans and TDD. This continues the approved local automatic extraction workflow; user explicitly requests preserving strokes, outline and shadow while reducing residual background.

**Goal:** retain source-resolution glyph detail and associated effects on textured backgrounds without cloud/API keys or a new model.
**Architecture:** retain RapidOCR detector; derive aligned glyph seeds, estimate a local background outside bounded stroke support, and recover attached outline/shadow by observed contrast. Do not blindly dilate alpha. Keep crop fallback for unsupported/ambiguous text and preserve source RGB/alpha. Process oversized OCR lines in overlapping source-resolution tiles instead of shrinking away thin strokes.
**Stack:** existing NumPy, OpenCV, Pillow, Python CPU (two threads).
**Spec:** user's 26/10 follow-up plus approved local-image design.

## Choices and constraints

- Threshold-only expansion is cheap but loses dark outline or copies background. Whole-image neural matting adds model/runtime cost. Use bounded local color/geometry refinement with conservative fallback; this is an implementation choice within the existing approved design.
- No new dependency, no inpainting, no OCR re-typesetting, no network inference. Preserve visible source pixels; a single flattened image cannot uniquely recover every translucent effect.
- Limit each analysis tile to 350k pixels; effect width scales with detected line height, with a fixed cap. Keep the current engine/cache/checkpoint contract.
- Work in place: workspace has no Git metadata. Store baseline worker sources and real output artifacts under temp/text-quality; use manual ledger here instead of Git-only skill scripts.

## Review focus

- Dark outline around bright/colored fill must survive while nearby background edges do not.
- Vietnamese accents, punctuation and narrow strokes at source resolution must survive.
- Soft shadow must remain partial alpha, rather than an opaque background band.
- Ambiguous texture must fall back instead of masquerading as clean extracted text.
- Rotated polygons, existing source transparency and tile boundaries must remain valid.

## Tasks

### 1. Reproduce and pin quality regressions

- [x] Preserve baseline module; export actual OCR regions from the existing red graphic, white subtitle on meeting footage, and yellow outlined text on interview footage. Frames at 0 seconds of existing 1920×1080 clip_scene_021/022.mp4, no download; exact source paths in QA result JSON.
- [x] Add failing tests using independently rendered fill/outline/shadow layers: effect recall, thin accents/punctuation, low background leakage, tiled source-size detail, no-text negatives, existing alpha.

### 2. Repair text masking and source detail

Files: workers/text_alpha.py; new workers/text_effects.py if needed; workers/masks.py; test/python/test_text_alpha.py.
Interface: estimate_text_alpha(rgb, polygon) -> {alpha: uint8 HxW, method, diagnostics}|None; export_text preserves source coordinates/RGB/alpha.

- [x] Separate glyph seed/alignment evidence from effect support. Estimate local background from pixels outside a narrow support; include outline/shadow only near confirmed glyphs with contrasting evidence. Retain accents and punctuation geometrically associated with the line.
- [x] Expand export padding enough for effects; retain rotated polygon constraints and use source-resolution tiles for large lines. Make uncertainty visible via metadata/warning.
- [x] Run Python suite after each coherent change; document any fallback/limits based on actual evidence.

### 3. Verify actual images and integration

- [x] Run full Node and Python suites, actual CPU inference, and baseline/current comparisons using identical OCR polygons. Save readable checkerboard and light/dark background previews plus measurements.
- [x] Fresh reviewer inspects boundedness, false positives, source alpha and tile handling; fix important findings with regression tests.
- [x] Open a new app result, verify text filter/PNG/ZIP and absence of console errors; document runtime/memory, supported cases and unresolved limits.

## Ledger

- Pre-flight: tasks 1/2 share estimate_text_alpha/export_text unchanged public interface; task 3 uses new fingerprint automatically because engine hashes workers/*.py. No API/cache schema change required.
- Ruling: execute within the already approved workflow, no new design approval round; user explicitly authorized this targeted continuation. No Git/worktree actions possible in this workspace.
- Reproduced: fill-only alpha drops dark outline/shadow; >350k resizing can recurse indefinitely because rounding does not reduce area. Native tiles remove that recursion path.
- Reproduced/fixed: disconnected dark decoration retained as shadow (46% sample coverage); filter connected effect components that meet glyph boundary. Gray anti-aliased pixels over outline must remain opaque; rotated control recall improved past 85% gate.
- Review correction: preserve validated smooth-plane support when combining detail, so minority fill colors and red/blue/cyan outlines cannot be discarded by a dominant-color glyph candidate. Regression mixed-color word recall was 0% before repair.
- Limitation: textured mixed-color/colored-outline text may remain incomplete; current effect model targets dark outline/shadow. A giant mixed/occluded red title now uses honest crop when native tiles lack sufficient glyph evidence, rather than exporting a potentially incomplete alpha.
- Complete: Node15/15, Python26/26; fresh reviewer confirms fixes. Actual HTTP smoke job 2f5c364f-930f-4dca-a011-37364f1eb4b6, PNG/ZIP/cache/cancel pass, browser text filter6alpha and no console errors. ZIP6PNG+6mask+manifest CRC valid. Evidence and limits in docs/REPORT-complex-text-2026-10-26.md.
