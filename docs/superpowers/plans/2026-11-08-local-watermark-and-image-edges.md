# Local watermark suggestions and image edge refinement

The watermark tool should suggest editable boxes as soon as an image opens. Reuse RapidOCR for brand text and OpenCV for icon matching. Keep both operations on CPU with the packages already installed. A TikTok or Douyin icon without identifying text has a shared label. Ship the small versioned icon masks with the worker.

The image pipeline should keep the current MobileSAM grid and add up to 12 points inside compact edge contours that the grid misses. At final export, compare foreground and background colors on the original image to correct a narrow boundary band. Bound the crop cost and keep the proxy result where evidence is weak. Preserve source RGBA and graphic exclusions.

- [x] Verify logo-only, text-only and negative fixtures at source coordinates. Reuse the watermark route lifecycle for detection and ensure detection never writes a cleaned image.
- [x] Add the automatic scan and box edits to the existing page. Let users edit, discard or add boxes before the existing removal action.
- [x] Add regressions for a small object between grid points and for an aliased boundary. Compare CPU output with the earlier pipeline on the existing real reference and a known small-object fixture.
- [x] Run Node and Python tests and verify the local browser workflow.

## Verification

- Node 37/37 and Python 47/47. Detection tests include logos of different sizes and polarities, OCR wordmarks, handle grouping and an empty image. Three existing textured images that produced early false suggestions returned no boxes after calibration.
- Browser auto-detected the synthetic TikTok watermark and handle. The box changed from `(809, 568, 126, 74)` to `(804, 568, 131, 74)` through the edit form. Removal was disabled during the edit, and saving produced a PNG preview and download link after removal. Screenshot at `test-results/watermark/auto-suggestion.jpg`.
- The `grid-gap` MobileSAM benchmark isolated a 27 × 27 px circle that had no region asset in the baseline. The separate OCR false crop of the larger shape remained. Compare `grid-gap-fast-1794106807724` and `grid-gap-fast-1794107049907` under `test-results/images`.
- The curved-edge fixture decreased incorrect mask pixels from 371 to 0 with a solid fill and from 371 to 205 with a black outline. The outlined case kept the same 807 outline pixels as the baseline. Source RGBA remained intact where the final mask kept pixels.
- Final real-image benchmark `anime-reference-fast-1794107610506` retained three assets, 11/11 ray centers, transparent ray gaps and 6/6 character landmarks. The comparison is a narrow regression, not a general accuracy benchmark. Platform tests use representative rendered artwork and text. A representative dataset of platform exports is still needed to quantify recall and false positives.
