# Local layer editing and text edge repair

> Execute with Superpowers TDD, bounded independent workers, final fresh review. User requests implementation and explicitly chose visible source pixels + optional original B import for occlusion recovery.

**Goal:** reduce text halo/multicolor-outline loss; provide precise manual mask/layer repair and original-source import to obtain both overlapping objects without hallucinating hidden pixels.
**Architecture:** existing Express/Sharp/Python + plain browser Canvas. No new runtime/model/dependency/API key. Add optional editor page after automatic scanning, non-destructive source/mask revisions and native PNG export. Text edge cleanup may estimate RGB only in translucent edge pixels, with explicit metadata and an original source variant retained; never claim those estimated colors are original pixels.
**Spec:** latest request 26/10 and user response: preserve visible pixels, import original B when hidden. No exact recovery of absent pixels from flattened input.

## Tasks / ownership

- [x] Text worker: multicolor effects, fractional foreground estimate, original RGBA sourceFile and explicit correction metadata; six new regressions; before/after QA saved.
- [x] Layer backend: native independent mask edits/import/placement, immutable baseline/source, locks/revisions/rollback/budgets, optional source cache retention and raster-work preflight.
- [x] Editor UI: separate page/entry, visibility/order/solo/zoom/pan, brush/polygon/undo, native save/reset/import/export and source link. New geometry/history/initial-selection tests pass.
- [x] Integration: Node29/29, Python32/32; real image/reference inference and before/after saved; native two-asset smoke/ZIP CRC pass; actual browser import/brush/polygon/save/reset tested, fresh review fixes complete. Final report docs/REPORT-layers-text-2026-10-27.md.

## Backend contract (root UI and worker backend use exactly this)

- Existing GET /api/jobs/:id returns public job with element editRevision (default 0), placement {x,y} (default bbox origin), layerVisible (default true), layerOrder (default array order). Edits never change native bbox width/height.
- GET /api/jobs/:id/elements/:elementId/edit -> {element, width,height,sourceUrl,maskUrl,previewUrl,revision}. sourceUrl serves full original source crop RGBA preserving source alpha. maskUrl serves current alpha PNG; lazy generation for crop elements allowed. previewUrl current PNG. Element may include optional sourceFile written by text worker; backend may derive original source crop from job source/bbox.
- POST /api/jobs/:id/elements/:elementId/mask JSON {revision,operations:[{kind:'brush',mode:'add'|'erase',radius,points:[[x,y],...] }|{kind:'polygon',mode:'add'|'erase',points:[[x,y],...]}]} -> public job. Native crop-local coordinates, radius 1..256, max100 operations/10000 aggregate points, JSON <=1MB. Server restores RGB from original crop for edited region; preserve current corrected RGB outside changed areas. Source alpha ceiling always applies. revision mismatch409.
- POST /api/jobs/:id/elements/:elementId/reset-mask JSON {revision} -> public job, restore initial extraction PNG+mask (never reset to all opaque).
- POST /api/jobs/:id/layers multipart {file,label?,x?,y?} -> public job, new region_NNN preserving imported original RGBA/dimensions, default placement 0,0, full alpha initially. Treat as original additional layer, not hidden-pixel reconstruction.
- PATCH /api/jobs/:id/layers JSON {layers:[{id,x,y,visible,order}]} -> public job. Validate known unique ids; bounded finite coordinates, integer order. Per-element fields placement/layerVisible/layerOrder. No resampling to save placement. Visible is preview state, selected controls export.
- Media URLs can expose edit-source/edit-mask only through controlled known-element route or generated source/mask metadata. Retain existing image/thumb/mask URL compatibility and revision cache busting.

## Review focus

Opaque ink/RGB must not be damaged by halo cleanup. Distinct outline palettes must not be collapsed to fill color. Changes to RGB edges must be disclosed and source retained. Restore must obey original alpha and never blur/rescale native source. Each layer is independently editable; don't cut B further merely because A exists. Hidden pixels only restored by imported original. Path scoping, pixel/artifact limits and atomic snapshots remain enforced. Concurrent edits/imports serialize and stale revisions fail. Tests pin mask geometry, undo and source-pixel equality.

## Ledger

- No Git metadata; work in authorized workspace. Existing server localhost3000; restart only at integration after backend changes and no active jobs.
- User chose source-preserving recovery/import, not AI-generated hidden content. Automatic source masks remain default; manual repair is optional after scanning.
- Parallel domains have explicit file ownership and API contract above. Text sourceFile is optional; backend derives source crop when absent, so no dependency on text worker finishing first.
- Review fixes: raster-work guard rejects expensive geometry before decode/write; save controls block concurrent UI mutation; shared draft loading promise fixes A→B→A; every ready draft renders in composition. Exact deferred-loading harness green.
- Final browser correction: editor entry selects visible imported B when earlier automatic layers are hidden; explicit requested element takes priority. Added failing regression then passed full Node29. Browser import of original B to cached test job preserves162×451; location/visibility/selection saved.
- Reference job cd2962a0-401d-4e7f-bf1e-ce50504a85b9, imported B region_001 and A region_002. B restore RGBA equals original/A unchanged. Inference25.314s. Full HTTP smoke interview b72736ab-165b-4787-9b01-cccc3b66157e passed. Meeting partial is reported honestly (80proposal cap), not marked smoke passing.
