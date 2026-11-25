# SDD ledger — plan: docs/superpowers/plans/2026-10-25-local-image-elements.md

Ruling: execute inline without another approval — user explicitly approved design and requested implementation.
Ruling: workspace has no Git metadata; use reversible legacy source snapshot, do not initialize Git or fabricate commits/worktree.
Pre-flight: Task 1 config/store feeds Task 3 pipeline and API; Task 2 worker returns elements in normalized source coordinates and files relative to output; Task 4 consumes Task 3 ID-based URLs. No interface conflicts.

Task 1: complete — normalized ingestion/SQLite/path tests passed; source/test/scripts/docs video moved reversibly under legacy/video; data and .env retained.
Task 2: complete — installed CPU torch/torchvision and pinned MobileSAM, bundled RapidOCR detector with model hashes; doctor ready; actual inference ran offline with socket guard. Python mask/alpha/coordinate/empty tests passed.
Task 3: complete — HTTP lifecycle/export/cache/cancel/timeout tests passed; actual HTTP smoke produced 7 masks, PNG/ZIP, cache hit and canceled job. Fixed review findings via regression tests.
Task 4: implemented — Vietnamese source/gallery workspace, dialog/alpha check, rename, bulk selection, responsive history, persistent job URL, reduced-motion and polling lifecycle. Browser real progress/results/rename and 375px inspected; final contain-layout recheck pending.
Task 5: in progress — README, model/package lock and notices written; initial fresh review fixed. Node final13, Python4, legacy84 and pip check passed. Final targeted review/browser recheck pending.

Ruling: keep MobileSAM grid8/12; reduce OCR work by using TextDetector directly with a960px input, not by silently reducing mask coverage. Measured first anime wall52.35s → optimized benchmark24.09s/API26.525s; counts differ after false-positive/background filtering, not a reviewed recall claim.
Ruling: original .env FFmpeg binary referenced an old user path and current FFmpeg removed vsync. Legacy launcher falls back to PATH for missing configured binaries; equivalent fps_mode passthrough restored all84 legacy tests.
Ruling: browser extension denies automated file upload without extra file-URL permissions. Do not expand permissions; verify real upload via HTTP and use browser history to inspect actual job results. Record that file-picker automation was not completed.

Task 4: complete — final contain layout, mobile history and job URL recovery verified in integrated browser at375/768/1440px; no horizontal overflow; upload→scan→bulk selection→PNG download completed through UI. Edge upload restriction was resolved by using the integrated browser without changing permissions. Screenshot: test-results/ui/desktop.jpg. Browser viewport restored.
Task 5: complete — fresh reviewer found one additional checkpoint case (OCR failed + segmentation interrupted); regression watched fail and then pass, retaining valid masks as partial without claiming engine completion. Final14 Node tests,4 Python tests and84 legacy tests passed; pip check clean, setup script ran successfully, health/engine readiness passed. No Git metadata; no commit/PR created.
Ruling: script UTF-8 BOM is required by installed Windows PowerShell5.1. Initial actual setup run exposed parser failure; adding BOM and rerunning the supplied script succeeded. Lock constraints now applied without overwriting the checked-in lock with a machine-specific file URL.
Ruling: report all measured latency, including latest UI run70.529s after earlier24–27s runs; do not present best sample as a guarantee. Worker peak observed720–792MiB, excludes Node/browser. No labeled precision/recall claim.
Final app: localhost127.0.0.1:3000, hidden background Node process (PID recorded in temp/image-server.pid). Source video/data/.env retained; old code is under legacy/video.
