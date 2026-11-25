# Nhận diện, tách nền mềm và xử lý nhiều vật thể — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tăng recall vật thể nhỏ/đông, cho alpha mềm ở biên (tóc, glow, khử răng cưa) thay cho mask nhị phân, và tách pixel chồng lấn giữa các vật thể thành layer có thứ tự trước/sau — vẫn chạy CPU local, không API key.

**Architecture:** Giữ nguyên pipeline `OCR → MobileSAM point grid → consolidate_candidates → export`. (1) Giữ low-res logits của SAM cho từng candidate, tinh chỉnh lại các vật thể cuối bằng prompt box + mask, rồi xuất alpha từ logits nội suy lên ảnh nguồn + guided filter. (2) Preset **Kỹ** thêm một lượt quét tile 2×2 cho vật thể nhỏ. (3) Tổng quát hóa logic `occludedBy` (hiện chỉ dành cho graphic multipart) cho mọi cặp vật thể chồng lấn và gán `layerOrder`.

**Tech Stack:** Python 3.10 + numpy/OpenCV (`opencv-python`, không có contrib) + torch CPU + MobileSAM; Node 22 Express; test `unittest` + `node --test`.

**Spec:** Không có spec riêng — plan này dựa trên yêu cầu người dùng 20/11/2026 ("cải thiện nhận diện và tách nền; nâng cấp nhận diện và xử lý nhiều vật thể") và các giới hạn đã ghi trong `README.md` mục *Giới hạn* và `docs/REPORT-element-quality-2026-10-26.md`.

## Hiện trạng (đọc trước khi làm)

- `workers/engine.py`: một embedding MobileSAM trên proxy 768px (Nhanh, lưới 8×8) / 1024px (Kỹ, 12×12) + ≤12 điểm phụ từ `uncovered_points`. Lọc `predictedIoU ≥ 0.82`, `stability ≥ 0.90`. Mask **nhị phân** ở độ phân giải proxy (`return_logits=False`).
- `workers/masks.py::export_mask`: phóng mask proxy bằng `INTER_NEAREST`; `_native_boundary` chỉ "snap" cứng 0/1 theo màu → biên tóc/glow bị răng cưa hoặc mất, không có alpha bán trong suốt.
- `workers/regions.py::consolidate_candidates`: chọn mask toàn thể, bỏ bộ phận/trùng; chỉ graphic multipart được khoét khỏi vật thể bên dưới (`occludedBy`). Hai nhân vật chồng nhau hiện **cùng giữ pixel vùng chồng**.
- Benchmark `test-results/multi-object/benchmark.json`: ảnh meeting 86 proposal → 19 vùng (48 trùng); workshop 149 → 35. Peak worker ~760–800 MiB.
- Chưa có thước đo chất lượng mask tổng quát; `scripts/evaluate-reference-quality.py` chỉ kiểm landmark của một ảnh.
- Thư mục **không phải git repo** → bước "Commit" trong plan đổi thành "chạy lại toàn bộ test"; nếu người dùng `git init` trước thì commit theo task.

## Global Constraints

- Chỉ CPU, offline; worker vẫn chặn mạng; `torch.set_num_threads(2)`, OpenCV 2 thread.
- Không thêm dependency Python/Node và không tải model mới (Task 7 là ngoại lệ chỉ khi người dùng duyệt).
- Giới hạn giữ nguyên: 80 asset, 180 s/giai đoạn model, 512 MB artifact/job.
- Ngân sách hiệu năng (đo bằng `npm.cmd run benchmark:images` trên 3 ảnh benchmark hiện có): preset Nhanh tổng thời gian ≤ +20% so với baseline; preset Kỹ ≤ +60%; peak worker ≤ 1,2 GiB.
- Pixel RGB nguồn ở vùng alpha = 255 không bị thay đổi. Mọi file RGB đã ước lượng màu phải đi kèm `region_XXX.source.png` (pattern đã được `validateElements` chấp nhận) và `sourcePixelsOnly: false`.
- Bump `pipelineVersion` trong `workers/engine.py` và `pipeline: 3` trong `src/features/elements/pipeline.js` lên `4` (một lần, ở Task 2).
- Copy UI/cảnh báo bằng tiếng Việt, giọng như các `edgeWarning` hiện có.

## Review Focus

1. Ảnh nguồn có alpha (PNG trong suốt): alpha xuất ra phải ≤ alpha nguồn ở mọi pixel → test trong Task 2.
2. Vật thể chạm mép ảnh hoặc mép tile: không bị cắt thành mảnh trùng với bản quét toàn ảnh → test trong Task 4.
3. Vật thể lồng nhau hợp lệ (đồ vật cầm trên tay nhân vật): không bị coi là "chồng lấn" làm khuyết nhân vật khi không độc lập → test trong Task 5.
4. Job bị hủy/timeout giữa lượt tile hoặc lượt refine: checkpoint vẫn là thế hệ element hợp lệ → test trong Task 4 (Node `pipeline.test.js` với worker giả trả checkpoint).
5. Nền trơn tương phản cao (logo phẳng): alpha mềm không được làm mờ biên vốn sắc → test trong Task 2.

---

### Task 1: Bộ đo chất lượng mask có ground truth

**Files:**
- Create: `scripts/evaluate-masks.py`
- Create: `test/python/test_evaluate_masks.py`
- Create: `test/fixtures/masks/README.md` (cách tạo GT: chạy quét → sửa mask trong **Chỉnh layer** → tải ZIP → chép `*.mask.png` + bbox vào `test/fixtures/masks/<tên-ảnh>/gt.json`)

**Interfaces:**
- Produces: `evaluate(result_dir: Path, gt_dir: Path) -> dict` với khóa `recall50`, `recall75`, `meanIoU`, `boundaryF`, `meanAlphaSAD`, `duplicates`, `perObject: list[dict]`; CLI `python scripts/evaluate-masks.py <job-elements-dir> <gt-dir> [--json out.json]`.

GT format `gt.json`: `{"image":[w,h],"objects":[{"name":"char_a","mask":"char_a.png","bbox":[x,y,w,h]}]}`, mask là alpha 8-bit trong bbox. Ghép mỗi GT với element có IoU cao nhất (Hungarian không cần: greedy theo IoU giảm dần). `duplicates` = số element có IoU > 0.5 với một GT đã được ghép. `boundaryF` dùng dung sai 3 px trên ảnh nguồn. `meanAlphaSAD` = trung bình |alpha_pred − alpha_gt|/255 trong dải biên 8 px của GT.

- [ ] **Step 1: Viết test thất bại** — `test_perfect_prediction_scores_one`, `test_shifted_mask_lowers_boundary_f_but_not_recall50`, `test_duplicate_is_counted_once_as_match_once_as_duplicate`; dữ liệu tổng hợp: hai đĩa tròn 60 px trên canvas 200×200 ghi ra `tempfile`.
  ```python
  self.assertEqual(r['recall50'], 1.0); self.assertAlmostEqual(r['meanIoU'], 1.0)
  self.assertLess(shifted['boundaryF'], .9); self.assertEqual(shifted['recall50'], 1.0)
  self.assertEqual(dup['duplicates'], 1)
  ```
- [ ] **Step 2:** `.venv/Scripts/python.exe -m unittest test.python.test_evaluate_masks -v` → FAIL (module chưa có).
- [ ] **Step 3:** Viết `scripts/evaluate-masks.py` (`load_module` trong test như `test_trim_local_runtime.py` đang làm).
- [ ] **Step 4:** Chạy lại → PASS.
- [ ] **Step 5 (người dùng + agent):** Gắn nhãn tối thiểu 3 ảnh: `anime-reference.png` (1 nhân vật + mặt trời), `meeting.png` (đông người), một ảnh có tóc/glow do người dùng chọn. Chạy pipeline hiện tại, lưu baseline: `test-results/detection-v4/baseline.json`.

### Task 2: Alpha mềm từ logits SAM + guided filter

**Files:**
- Modify: `workers/engine.py` (vòng predict: `return_logits=True`, mask = `logits > 0`; lưu `low_res` float16 256×256 vào candidate thay vì giữ thêm mask float)
- Modify: `workers/masks.py` (thêm 2 hàm, `export_mask` nhận `logits`)
- Modify: `src/features/elements/pipeline.js` (`pipeline: 4`)
- Test: `test/python/test_masks.py`

**Interfaces:**
- Produces:
  - `upsample_logits(low_res: np.ndarray[256,256], proxy_shape: tuple[int,int], source_shape: tuple[int,int], box: tuple[int,int,int,int]) -> np.ndarray[float32]` — logits ở tọa độ nguồn chỉ trong `box` (left, top, right, bottom); tái hiện `postprocess_masks` của SAM: phóng 256→1024, cắt phần ứng với proxy (cạnh dài = 1024), phóng bilinear lên kích thước nguồn.
  - `guided_alpha(guide_rgb: np.ndarray[uint8], alpha: np.ndarray[float32 0..1], radius: int, eps: float = 1e-3) -> np.ndarray[float32]` — guided filter He et al. bằng `cv2.boxFilter` (không có `ximgproc`).
  - `export_mask(source, mask, output, element_id, exclusions=(), refine_edges=False, logits=None)` — khi có `logits`: alpha = `sigmoid(logits)` → vùng chắc chắn (erode/dilate bán kính `ceil(source/proxy scale)+1`) giữ 0/255, dải biên lấy `guided_alpha` với `radius = 2*scale`; sau đó vẫn `min` với alpha nguồn và `exclusions`. `refinement.alphaMethod = 'sam-logits-guided'`. Khi `logits is None` giữ đường `_native_boundary` hiện tại.
- Candidate dict trong engine thêm khóa `'lowRes'`; `consolidate_candidates` phải mang khóa này qua (đã copy `**candidate`).

- [ ] **Step 1: Test thất bại** trong `test_masks.py`:
  - `test_soft_alpha_has_fractional_edge_on_antialiased_disk`: nguồn 400×400 có đĩa khử răng cưa, logits giả = SDF đĩa ở 256×256; kỳ vọng `0 < alpha < 255` trên ≥ 60% pixel biên, sai số trung bình so với coverage giải tích < 0.12, tâm = 255, góc = 0.
  - `test_soft_alpha_keeps_sharp_edge_on_flat_logo` (Review Focus 5): hình vuông đặc trên nền trơn → độ rộng dải 1..254 ≤ 2 px.
  - `test_soft_alpha_never_exceeds_source_alpha` (Review Focus 1).
  - `test_upsample_logits_matches_proxy_aspect` cho ảnh 1920×1080 → không lệch > 1 px tại mép đĩa đặt gần biên phải/dưới.
- [ ] **Step 2:** `.venv/Scripts/python.exe -m unittest test.python.test_masks -v` → các test mới FAIL.
- [ ] **Step 3:** Cài đặt các hàm trên; trong engine truyền `logits=upsample_logits(...)` khi gọi `export_mask` cho candidate không multipart; bump `pipelineVersion` → 4.
- [ ] **Step 4:** Chạy toàn bộ Python + `npm.cmd test` → PASS (test cũ `_native_boundary` vẫn phải qua).
- [ ] **Step 5:** Benchmark 3 ảnh, chạy `evaluate-masks.py`; kỳ vọng `meanAlphaSAD` giảm ≥ 20% so với baseline, `boundaryF` không giảm. Ghi `test-results/detection-v4/task2.json`.

### Task 3: Khử lẫn màu nền ở pixel bán trong suốt

**Files:**
- Modify: `workers/masks.py`
- Test: `test/python/test_masks.py`

**Interfaces:**
- Consumes: alpha float từ Task 2.
- Produces: `estimate_foreground(rgb: np.ndarray[uint8], alpha: np.ndarray[float32]) -> np.ndarray[uint8]` — blur-fusion 2 mức (Germer et al. 2020): ước lượng F/B cục bộ bằng `cv2.blur` có trọng số alpha / (1−alpha), bán kính 45 rồi 3. Chỉ ghi pixel `0 < alpha < 1`; pixel alpha = 1 giữ RGB nguồn.
- `export_mask` khi có `logits`: lưu `region_XXX.source.png` (RGBA nguồn chưa sửa), đặt `sourceFile`, `sourcePixelsOnly=False` nếu RGB thay đổi, thêm câu cảnh báo giống `export_text` ("Màu RGB ở biên bán trong suốt đã được ước lượng…").

- [ ] **Step 1: Test thất bại** `test_translucent_edge_color_moves_toward_foreground`: nhân vật đỏ trên nền xanh, biên alpha 0.5 trộn tím → sau ước lượng kênh B tại biên giảm ≥ 50%; `test_opaque_pixels_are_untouched` so sánh byte-for-byte; `test_source_file_is_written_when_rgb_changes`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Cài đặt; kiểm tra `src/features/elements/editing.js` vẫn dùng `sourceFile` cho chỉnh layer (đã có cho text — không cần sửa nếu chỉ dựa vào tên trường).
- [ ] **Step 4:** Toàn bộ test Python + Node → PASS; thêm assertion vào `test/image/pipeline.test.js` rằng element `region_*` có `sourceFile` vẫn qua `validateElements` và được đóng gói ZIP.

### Task 4: Tăng recall vật thể nhỏ — refine prompt + quét tile (preset Kỹ)

**Files:**
- Modify: `workers/engine.py`
- Modify: `workers/regions.py`
- Test: `test/python/test_regions.py`

**Interfaces:**
- Produces:
  - `refine_candidate(predict, candidate: dict) -> dict` trong `regions.py`. `predict(point_xy, box_xyxy, mask_input) -> (mask, score, low_res)` là callable (engine bọc `predictor.predict` với `multimask_output=False`). Chỉ nhận kết quả khi `score >= candidate score - 0.02` **và** IoU(mới, cũ) ≥ 0.70; nếu không trả candidate gốc. Ghi `refinement.promptRefined: bool`.
  - `tile_boxes(proxy_shape, source_shape, grid=2, overlap=0.25) -> list[tuple[int,int,int,int]]` — trả `[]` khi cạnh dài nguồn < 1.5 × cạnh dài proxy (không có lợi về độ phân giải).
  - `drop_tile_edge_masks(mask: np.ndarray, tile_box, image_shape, margin=2) -> bool` — True nếu mask chạm mép **trong** của tile (không phải mép ảnh) → loại (như `crop_n_layers` của SAM AMG).
- Luồng engine: sau vòng lưới toàn ảnh, nếu preset `balanced` và `tile_boxes` khác rỗng: với mỗi tile, crop từ **ảnh nguồn**, `set_image` lại (cạnh dài 1024), lưới 6×6, cùng ngưỡng; mask chiếu về tọa độ proxy (`INTER_AREA` rồi `> .5`) và đưa qua cùng `MaskFilter`. Sau `consolidate_candidates`, gọi `refine_candidate` cho từng candidate không multipart với embedding toàn ảnh (cần `set_image(proxy)` lại một lần). Emit `{'type':'stage','stage':'tiles'}` trước lượt tile; checkpoint sau mỗi tile.
- `postprocess` thêm `tilePrompts`, `tileRegions`, `promptRefined`.

- [ ] **Step 1: Test thất bại**:
  - `test_refine_rejects_drifting_mask` / `test_refine_accepts_tighter_mask_with_equal_score` (predict giả).
  - `test_tile_boxes_skip_low_resolution_sources`, `test_tile_boxes_cover_image_with_overlap`.
  - `test_mask_touching_inner_tile_edge_is_dropped_but_image_edge_is_kept` (Review Focus 2).
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Cài đặt; cập nhật bảng progress trong `pipeline.js` `({text:20,masks:35,tiles:75,refining:90})`.
- [ ] **Step 4:** Test Node mới trong `test/image/pipeline.test.js`: worker giả phát `stage: tiles` rồi bị abort → job `partial` giữ element checkpoint hợp lệ (Review Focus 4). Toàn bộ test PASS.
- [ ] **Step 5:** Benchmark meeting/workshop preset Kỹ: `recall50` tăng, `duplicates` không tăng, thời gian trong ngân sách +60%. Nếu vượt: giảm lưới tile 6×6 → 4×4 trước khi đổi gì khác.

### Task 5: Phân xử pixel chồng lấn và thứ tự layer

**Files:**
- Modify: `workers/regions.py` (`consolidate_candidates`, phần sau khi `kept`)
- Modify: `workers/engine.py` (ghi `layerOrder`)
- Test: `test/python/test_regions.py`

**Interfaces:**
- Produces: `resolve_overlaps(kept: list[dict], lab: np.ndarray) -> dict` trả `{'pairs': int, 'order': list[str]}`; sửa tại chỗ `mask` của vật thể phía sau và thêm `occludedBy` (đã có field + cảnh báo trong engine).
- Quy tắc "ai ở trước" cho cặp (A, B) với overlap ≥ 2% vật thể nhỏ hơn và không phải quan hệ bộ phận (`_contains_part` False):
  1. Nếu một bên `_independent` so với bên kia (đã có hàm) → bên đó ở trước.
  2. Ngược lại so độ mạnh biên ảnh (Sobel trên kênh L) dọc đường viền của mỗi mask **nằm bên trong** vùng mask kia: viền thật của vật thể trước trùng cạnh ảnh mạnh hơn → bên có trung bình gradient lớn hơn ở trước.
  3. Hòa (chênh < 10%) → `predictedIoU` cao hơn ở trước.
- Vật thể phía sau bị khoét pixel vùng chồng (để trong suốt, không inpaint — đúng chính sách hiện tại). `layerOrder` = sắp xếp topo theo quan hệ trước/sau, phá chu trình bằng diện tích (lớn ở sau). Graphic multipart giữ logic cũ.

- [ ] **Step 1: Test thất bại**:
  - `test_overlapping_characters_do_not_share_pixels`: hai hình elip màu khác chồng 20%, elip trên có viền tối → sau xử lý giao = 0 pixel và elip dưới có `occludedBy`.
  - `test_held_item_inside_character_without_contrast_is_not_cut` (Review Focus 3).
  - `test_layer_order_puts_front_object_last`.
- [ ] **Step 2:** Chạy → FAIL.
- [ ] **Step 3:** Cài đặt `resolve_overlaps`, gọi trong `consolidate_candidates` sau khối graphic multipart; `stats['overlapPairs']`. Engine gán `item['layerOrder']` theo `order` (Node `publicJob` đã dùng `e.layerOrder ?? index`, layer editor đã tôn trọng — không sửa UI).
- [ ] **Step 4:** Toàn bộ test PASS; mở **Chỉnh layer** trên ảnh meeting, bật/tắt từng người → không còn "bóng ma" pixel trùng; chụp màn hình vào `test-results/detection-v4/`.

### Task 6: Đo lại, báo cáo, tài liệu

**Files:**
- Create: `docs/REPORT-detection-matting-2026-11-XX.md`
- Modify: `README.md` (mục *Giới hạn*, *Hiệu năng đã đo*, mô tả preset Kỹ có lượt tile)
- Create: `test-results/detection-v4/summary.json`

- [ ] **Step 1:** Chạy `npm.cmd test` và `.venv/Scripts/python.exe -m unittest discover -s test/python -v`; ghi số test.
- [ ] **Step 2:** Benchmark 3 ảnh × 2 preset; `evaluate-masks.py` trước/sau; kiểm tra ngân sách thời gian/RAM ở Global Constraints. Không đạt → ghi rõ trong báo cáo, không giấu.
- [ ] **Step 3:** Smoke thật: `npm.cmd start` + `node scripts/smoke-local.js <ảnh>`; kiểm tra UI desktop và 375px như các báo cáo trước.
- [ ] **Step 4:** Viết báo cáo (bảng trước/sau, ảnh so sánh trên nền caro/sáng/tối, giới hạn còn lại).

### Task 7 (tùy chọn — cần người dùng duyệt): Matting chuyên dụng cho nhân vật anime

Chỉ làm nếu sau Task 6, ảnh tóc/glow vẫn có `meanAlphaSAD` cao rõ rệt. Dùng model ONNX phân đoạn nhân vật anime (ví dụ ISNet của dự án `anime-segmentation`, ~170 MB, chạy bằng `onnxruntime` đã cài) làm prior alpha trong bbox các region lớn: `alpha_final = guided_alpha(source, max-trong-dải-biên(sam_alpha, isnet_alpha))`. Cần: kiểm tra license, thêm vào `models/manifest.json` + SHA256, `scripts/setup-local.ps1`, `doctor()`, `THIRD_PARTY_NOTICES.md`. Chi tiết task sẽ viết sau khi được duyệt.

## Ngoài phạm vi (cố ý bỏ)

- Gán nhãn ngữ nghĩa ("nhân vật A", "ghế"…) — cần model phân loại, không được yêu cầu.
- Bỏ qua điểm lưới đã nằm trong mask đã nhận để tăng tốc: có thể làm mất vật thể lồng nhau; chỉ cân nhắc nếu Task 4 vượt ngân sách thời gian.
- Inpaint phần bị che, khôi phục layer gốc.
