# Local image watermark removal implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user authorized immediate implementation with delegated choices.

**Goal:** Remove user-selected visible watermarks/logos from still images locally.

**Architecture:** Dedicated stateless upload route normalizes images, validates rectangles, runs an isolated Python worker and returns PNG; temporary files are removed after each request. A separate page provides native-size region selection, preview and download.

**Tech Stack:** Existing Express, multer, sharp, Python, OpenCV, numpy and Pillow; vanilla HTML/CSS/ES modules.

**Spec:** `docs/superpowers/specs/2026-10-27-watermark-design.md`

## Global Constraints

- No new dependencies/API keys/models; no changes to legacy video.
- JPG/PNG/static WebP, 20 MB / 24 MP, at most 20 rectangles.
- Summed region area <=20% of pixels and <=1,000,000 pixels; worker timeout 60 seconds.
- Original source retained; outside-selection RGBA and entire alpha unchanged.

## Review Focus

- EXIF rotation must agree with browser display and source coordinates.
- Invalid and oversized selections must be rejected before CPU work.
- Concurrent uploads, disconnects and shutdown must release locks and temporary files.
- Changing selection/file must never expose a stale downloadable result.
- Transparent input and regions touching an edge must preserve outside pixels.

### Task 1: Local processor and API

Files: create `workers/watermark.py`, `src/features/watermark/routes.js`, `test/image/watermark.test.js`, `test/python/test_watermark.py`; modify `src/app.js`.

Interfaces: Python `remove_regions(source: np.ndarray, regions: list) -> np.ndarray`; worker JSONL `{source,output,regions}` produces PNG at server-specified output and `{type:'result'}`. HTTP POST multipart `file,regions` returns `image/png`.

- [x] Write tests for real local output/pixel preservation, validation, EXIF, error cleanup, concurrent operation and cancellation.
- [x] Run tests; verify failure because route/processor is absent.
- [x] Implement validation, isolated worker, temporary-file lifecycle and app shutdown integration.
- [x] Run focused Node and Python tests, verifying zero failures.

### Task 2: Selection UI and delivery

Files: create `src/web/watermark.html`, `src/web/modules/watermark.js`, `src/web/modules/watermark-selection.mjs`, `src/web/styles/watermark.css`, `test/image/watermark-selection.test.js`; modify `src/web/index.html`, `README.md`.

Interfaces: `rectangleFromPoints(start,end,width,height)` returns integer `[x,y,width,height]` or null for empty drags; page posts regions in native pixels to Task 1 route.

- [x] Write and run failing geometry tests for reverse drags, clipping and empty selections.
- [x] Implement responsive page using existing tokens, keyboard fields, result invalidation, cancel and PNG download.
- [x] Run all Node/Python tests; exercise upload -> selection -> local removal -> comparison -> download in browser at desktop/mobile sizes.
- [x] Document usage, quality limits and checks in README and a report.

## Execution record

The workspace is not a Git checkout (`git status` reports no repository), so edits and checks run in the provided directory without branch/commit operations. Design/plan confirmation is covered by the user's explicit request to choose and implement immediately.

Final verification: `npm.cmd test` 36/36; Python unittest discovery 40/40. Browser upload, keyboard/pointer selection, processing, original/result comparison, download, stale-result invalidation and mobile layout passed. Independent reviewer confirmed the shutdown fix and reported no remaining concrete blockers. Evidence in `docs/REPORT-watermark-2026-10-27.md`.
