# Local Image Elements Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Track evidence here and in the progress ledger.

**Goal:** Automatic image element extraction on CPU without API keys, with a clean workspace UI and preserved legacy video app.
**Architecture:** Express owns uploads, persistent single-flight jobs and export; isolated Python workers perform RapidOCR detection and bounded MobileSAM automatic mask generation. Files and manifests use ID-scoped paths.
**Tech Stack:** Node 24, Express, Sharp, SQLite, Python 3.10, torch CPU, MobileSAM, RapidOCR/ONNX Runtime.
**Spec:** ../specs/2026-10-25-local-image-elements-design.md

## Global Constraints

Local inference, no API key, no network during inference. One CPU job, two waiting. Upload 20 MB, 24 megapixel; proxy 768/1024, grid 8/12, batch 8; max 80 assets, 180 seconds/model stage, 512 MB artifacts/job. Keep source data and legacy execution. No claim to original layers or all elements.

## Review Focus

Oversized/malformed/animated files must fail before expensive inference. Restart/cancel must not strand queue jobs. Export/media cannot escape job scope. Nested character/detail masks must not be indiscriminately deleted. Text crops must not be represented as clean transparent lettering.

### Task 1: Isolate legacy and build image ingestion/persistence

Files: legacy/video/{src,test,scripts}; src/{app.js,server.js,config/index.js}; src/features/{images,jobs}; src/shared/files.js; test/image/core.test.js.
Interfaces: createConfig(overrides), createStore(config), normalizeImage(input,dir,config), createApp(options) → Express app with close().
- [x] Add failing image validation, store restart and path-scope tests; run with `node --test test/image/core.test.js`.
- [x] Snapshot old application under legacy/video, adjust root data lookup without deleting data; add `start:legacy`.
- [x] Implement image config, bounded decoding/orientation/alpha, SQLite store and scoped file lookup; rerun tests.

### Task 2: Local inference, resource budgets and setup

Files: workers/{engine.py,masks.py}; scripts/{setup-local.ps1,doctor.js}; requirements-local.txt; models/manifest.json; src/integrations/python/worker.js; test/image/worker.test.js; test/python/test_masks.py.
Interfaces: runWorker({source,output,preset,signal,onEvent}) → {elements,warnings,engines,timings}; engineStatus() → readiness.
- [x] Add failing tests for mask filtering, alpha export and worker cancellation/timeout; run them and confirm missing functionality.
- [x] Install CPU-only dependencies in workspace venv, pin upstream and weights, implement offline worker with sequential engines, bounded grid/batch and explicit partial failure.
- [x] Verify deterministic tests and actual CPU inference, recording cold/inference time and peak process memory.

### Task 3: Job pipeline, HTTP lifecycle and export

Files: src/features/jobs/{store.js,queue.js,routes.js}; src/features/elements/{pipeline.js,export.js}; test/image/api.test.js.
Interfaces: queue.submit(job), queue.cancel(id), pipeline(job,signal), get job/media/export scoped by UUID.
- [x] Add failing upload→job→media→ZIP integration tests with injectable worker, invalid ZIP IDs, cache invalidation and cancellation.
- [x] Implement stage persistence, budgets, retry, rename/selection, cache, retention and streamed export; test restart and partial engine results.
- [x] Run app tests and a real upload/inference/download smoke with engines installed.

### Task 4: Workspace UI

Files: src/web/{index.html,styles.css,app.js}; src/web/modules/{api.js,preview.js,gallery.js}.
- [x] Build accessible Vietnamese upload/preset, stage progress/cancel, source overlay, result gallery, selection, rename and ZIP export, history and retry.
- [x] Verify real flow in browser at desktop and 375px, keyboard, error/empty/partial and hidden-tab polling behavior.

### Task 5: Regression, benchmark and review

Files: scripts/benchmark-images.js; README.md; THIRD_PARTY_NOTICES.md; docs/REPORT-local-image-elements.md.
- [x] Run image suite, Python suite, legacy suite/config checks and real CPU benchmark on existing real source frames.
- [x] Perform fresh independent whole-change code review, resolve important findings and rerun affected checks.
- [x] Document actual setup, measurements, limitations and commands. No git commit/worktree: workspace has no .git; preserve a source snapshot instead.
