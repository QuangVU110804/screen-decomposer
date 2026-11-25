# ADR 0003 — Asset provenance and quality

Date: 2026-09-01

Status: Accepted

## Decision

Assets use exactly four public modes:

- `DIRECT`: cropped source pixels only; `sourcePixelsRatio` must equal 1.
- `SEGMENTED`: source pixels isolated by a mask; the output must contain a meaningful alpha channel.
- `RECONSTRUCTED`: temporal inference or generated pixels were used; recovery masks and provider metadata are required.
- `FAILED`: the attempt is retained for diagnostics and hidden from the default gallery.

Quality is a weighted, explainable vector containing resolution, sharpness, visibility, occlusion, semantic/localization confidence, mask quality, reconstruction penalty and provenance. Vision confidence alone is never the asset quality.

Technical extraction is separate from legal permission to reuse an asset. The UI and manifest carry this notice and never claim that extracted content is copyright-free.
