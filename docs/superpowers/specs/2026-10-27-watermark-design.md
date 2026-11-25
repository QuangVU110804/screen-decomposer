# Local image watermark removal

User scope: images first, local CPU, no API key; leave legacy video alone. The user delegated design choices and authorized immediate implementation.

## Approach

Use installed OpenCV Telea inpainting with user-selected rectangles. It reconstructs a visible logo/watermark from neighboring colors; it does not recover the original covered pixels or remove invisible watermarks. Supports visible overlays from TikTok, Douyin, YouTube, Gemini and other sources without claiming automatic recognition.

Alternatives: a local generative model needs additional weights/runtime and more memory; cloud inpainting violates the local/no-key priority. No new dependency or model is needed for the selected approach.

## Behavior and constraints

- Dedicated `/watermark.html`, linked from the main app. Upload JPG/PNG/static WebP, up to 20 MB / 24 MP, reuse existing image normalization.
- Draw up to 20 rectangles or enter original-pixel coordinates using keyboard-accessible form fields. Remove individual selections or clear them. Changing selections invalidates an old result.
- POST multipart `/api/watermark/remove`: `file` plus JSON `regions` containing `[x,y,width,height]` arrays. Return full-resolution PNG. Preserve normalized source dimensions and every RGBA pixel outside selected rectangles; preserve alpha throughout.
- Limit the summed rectangle areas to 20% of image pixels and 1,000,000 pixels. Reject empty/invalid/out-of-bounds regions, animation, bad files and cross-origin writes.
- Run a separate bounded local Python worker using installed cv2/numpy/Pillow, timeout 60 seconds. One watermark operation at a time; disconnect/shutdown cancels the worker. Delete per-request temporary files on success, error and cancellation.
- Preview toggles between original and result; selection overlay is hidden on result. Download PNG only for the current selection. Original input stays untouched.
- Explain that large or textured areas may retain artifacts, and users must select visible marks manually. No provider presets that imply reliable automatic detection. No video changes.

OpenCV reference: https://docs.opencv.org/4.12.0/d7/d8b/group__photo__inpaint.html
