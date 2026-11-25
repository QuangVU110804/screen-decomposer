# Thin text and light-background shadow repair

> Continue the approved CPU-local text pipeline with Superpowers debugging, TDD and final fresh review. No model/API/dependency/editor change.

**Goal:** recover observed thin/blurred strokes and reduce irregular false-shadow fringes on light recomposition, without deleting true outline/shadow or altering opaque RGB.
**Architecture:** adaptive local-contrast glyph support, followed by a conservative repeated-glyph shadow envelope fitted to source evidence. New helpers remain bounded by the existing350k analysis tile and source-coordinate export contract. Full original source crops retained; RGB correction remains disclosed and source-alpha-capped.
**Spec:** user's27/10 continuation: reduce light-background halo, recover thin strokes, compare real before/after, local without API key.

## Work

- [x] Snapshot current text modules to temp/text-light-v3/baseline. Inspect real interview/meeting native crops and seed/alpha diagnostics; identify threshold fragmentation and loosely attached shadow texture.
- [x] Add independent thin-antialias and nuisance-background/shadow compositor regressions; see red first. Pin hand-checked real thin-stroke landmarks and negative background samples separately from production mask.
- [x] Recover weak strokes near validated line support using local contrast, preserve diacritics/punctuation; never fill letter counters or connect neighboring text lines blindly.
- [x] Bound shadow by repeated glyph evidence to remove dark background remnants on bright recomposition; preserve controlled true-shadow recall and opaque RGB/source alpha. Reject ambiguous cases rather than faking a clean mask.
- [x] Run Python/Node full suite, before/after13 real OCR crops with same polygons, controlled recall/alpha/composite metrics, actual app/ZIP/cache smoke, fresh reviewer; report improvements and regressions honestly.

## Review focus

Thin faint strokes must not become opaque background. White counters must remain transparent. Nearby text lines/decoration must not join the target line. Multicolor strokes and true soft shadows must retain their existing recall. Native tile stitching, source RGB at opaque pixels and source alpha ceiling must hold. New shadow fitting is evidence-bound, not blind morphology output.

## Ledger

- Workspace has no Git metadata; execute in place. Baseline is this task's current modules, not earlier quality snapshots.
- Diagnostic interview text003: V>220 seed splits `trong` characters; line-component filtering removes additional disconnected parts. text006 crop also contains adjacent yellow subtitle in padding. Existing effect support permits scene texture connected to only one local edge.
- Thin fixture observed red(None)->mask. Real hand-checked source landmarks saved separately; text0034/9->9/9 with three negatives below40 alpha. Adaptive support uses local contrast, projected fractional alpha and guarded minors so counters do not become ink.
- Shadow regression: nuisance patch attached to a true shadow has baseline alpha excess0.3902->0.2451; light-composite MAE95.746->59.222. Isolated-patch baseline already succeeded, so it is not used to claim quality gain.
- Fresh-review fixes: adaptive rejection now retries strict support (narrow lowercase fixture redNone->mask). Opaque-AA restoration now requires a local observed outline plateau; nearby black-line regression98.8% forcedopaque->29.6% (some peaks are underdetermined without an opaque anchor). Smoothed cap lookup removes angular/radial discontinuities. Reviewer confirms all24text tests pass, no unresolved material defect; adjacent subtitle remnants/uneven shadows remain.
- Tradeoff measured: multicolor control soft recall85.99%->84.09%, light-composite MAE8.158->8.832. This is a small regression in the generic control, reported alongside the improvement on thin and nuisance-background cases; no universal improvement claim.

- Completed: fresh Python37/37 and Node29/29; actual OCR/MobileSAM job24elements, ZIP/cache/cancel passed; six-text ZIP CRC and real9/9 stroke +3/3 negative landmarks verified. UI inspected on light/dark, console clean. Report: docs/REPORT-thin-text-light-2026-10-27.md.
