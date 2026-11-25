# Third-party code and model sources

This project integrates upstream packages through narrow adapters. Keep the licenses shipped with each installed distribution. Model/code attribution is separate from the user's rights to reuse pixels from an input image.

| Component | Source / pinned version | Upstream license |
|---|---|---|
| MobileSAM | https://github.com/ChaoningZhang/MobileSAM — `f706ad9c4eb7f219c00d9050e46328518ffb65d2` | Apache-2.0; upstream acknowledges Segment Anything / TinyViT |
| MobileSAM checkpoint | `weights/mobile_sam.pt` at the same official revision | See MobileSAM repository/license; SHA256 recorded in `models/manifest.json` |
| RapidOCR ONNX adapter | https://github.com/RapidAI/RapidOCR — PyPI `rapidocr-onnxruntime==1.4.4` | Apache-2.0 |
| PP-OCRv4 detector | `ch_PP-OCRv4_det_infer.onnx`, bundled in the pinned RapidOCR wheel; derived from PaddleOCR | See RapidOCR/PaddleOCR distributions and attribution; stored locally as `models/rapidocr/det.onnx` |
| PP-OCRv4 recognizer | `ch_PP-OCRv4_rec_infer.onnx` from the same installed RapidOCR wheel | See the RapidOCR and PaddleOCR distributions |
| Watermark matching silhouettes | [TikTok](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/tiktok.svg), [YouTube](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/youtube.svg), [Google Gemini](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/googlegemini.svg) rasterized and cropped to their alpha bounds | [Simple Icons CC0 1.0](https://github.com/simple-icons/simple-icons/blob/16.0.0/LICENSE.md). Brand marks belong to their respective owners. |
| PyTorch / torchvision | https://pytorch.org — `2.5.1+cpu` / `0.20.1+cpu` | BSD-style, see respective package licenses |
| ONNX Runtime | https://github.com/microsoft/onnxruntime — `1.20.1` | MIT |
| timm | https://github.com/huggingface/pytorch-image-models — `1.0.12` | Apache-2.0 |
| OpenCV | https://github.com/opencv/opencv — `opencv-python==4.10.0.84` | See OpenCV and wheel notices, including bundled components |
| Sharp / libvips | https://github.com/lovell/sharp | Apache-2.0 / LGPL-2.1-or-later for libvips; bundled notices apply |

The full Python environment is recorded in `requirements-local.lock.txt`, JavaScript dependencies in `package-lock.json`. Runtime package license files remain in `.venv/Lib/site-packages/*dist-info/` and `node_modules/`. `models/manifest.json` records exact model bytes and hashes. New inference uses no Anthropic API; that dependency is retained only to run the archived video application.
