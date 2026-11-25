# Video Scene Decomposer

Ứng dụng web single-instance dành cho editor: nhận YouTube URL hoặc video upload, phân hoạch toàn bộ video thành scene, chọn nhiều keyframe cho mỗi scene, nhận diện element, rồi xuất reusable asset theo ba nguồn gốc rõ ràng:

- `DIRECT`: crop hoàn toàn từ pixel nguồn.
- `SEGMENTED`: pixel nguồn được tách bằng mask/alpha.
- `RECONSTRUCTED`: có vùng được suy luận hoặc tạo lại; luôn kèm mask và tỷ lệ provenance.

Kết quả chính là scene timeline, element gallery và `video_asset_pack/`, không còn là danh sách full-frame PNG. Job cũ vẫn đọc/tải được dưới nhãn `legacy-frame` trong compatibility window.

## Yêu cầu

- Node.js `>=22.13.0` (`node:sqlite` được dùng cho persistence).
- FFmpeg và ffprobe.
- yt-dlp.
- Anthropic API key cho multi-keyframe scene understanding.
- Optional HTTP provider cho segmentation/inpainting; repo có deterministic local fallback để phát triển và test.

Kiểm tra runtime đã xác nhận cho workspace này ngày 2026-09-01: Node 24.12.0 và FFmpeg/ffprobe 6.1.3.

## Cài đặt

```powershell
npm.cmd install
Copy-Item .env.example .env
# Điền ANTHROPIC_API_KEY và kiểm tra đường dẫn binary trong .env
npm.cmd start
```

Mở `http://localhost:3000`. Server kiểm tra yt-dlp, ffmpeg, ffprobe và config trước khi lắng nghe.

## Pipeline v2

```text
INGESTING
  -> PROBING
  -> DETECTING_SCENES
  -> SELECTING_KEYFRAMES
  -> UNDERSTANDING_SCENES
  -> ASSOCIATING_ELEMENTS
  -> EXTRACTING_DIRECT_ASSETS
  -> SEGMENTING
  -> RECOVERING_BACKGROUNDS (optional)
  -> VALIDATING_ASSETS
  -> DEDUPLICATING
  -> PACKAGING
  -> DONE / PARTIAL / FAILED
```

Các invariant quan trọng:

- Scene dùng range `[start, end)` và partition đủ từ `0` đến hết video; budget không được âm thầm bỏ scene.
- Mỗi scene có ít nhất một keyframe; keyframe ghi lý do chọn.
- Vision nhận nhiều keyframe thuộc cùng scene và trả element observations với normalized bbox.
- Full frame chỉ là scene preview/evidence.
- Một scene/provider fail có thể tạo job `PARTIAL` thay vì xóa kết quả scene khác.
- Source được giữ trong cây job đến retention sweep để hỗ trợ re-analyze scene.
- Quality là vector giải thích được, không đồng nhất với Vision confidence.

## Artifact layout

Nội bộ:

```text
temp/jobs/<jobId>/
  source/
  scenes/scene_001/
    keyframes/
    analysis.json
    masks/
    assets/
    preview.jpg
  manifest.json
  pipeline-state.json
```

Asset pack tải về:

```text
video_asset_pack/
  manifest.json
  scene_001/
    scene_preview.jpg
    keyframes/
    assets/
    metadata.json
```

Manifest public không chứa filesystem path, API key hoặc raw provider request.

## API

Endpoint tạo job vẫn giữ đường dẫn ngắn:

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/extract` | Tạo job v2 từ YouTube URL/video ID |
| POST | `/api/extract/upload` | Tạo job v2 từ multipart field `file` |
| GET | `/api/jobs/:id` | Poll job; tự serialize theo schema v1/v2 |
| GET | `/api/jobs` | History có `resultType` và `legacyFrameResult` |

Scene-first API:

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/v2/config` | Public config từ registry tập trung |
| GET | `/api/v2/jobs/:id` | Job/video/stage summary, scene timeline và asset library |
| GET | `/api/v2/jobs/:id/scenes` | Scene summaries |
| GET | `/api/v2/jobs/:id/scenes/:sceneId` | Keyframes, elements, observations và asset của scene |
| GET | `/api/v2/jobs/:id/assets?type=&mode=&minQuality=` | Filtered asset library; failed bị ẩn mặc định |
| GET | `/api/v2/jobs/:id/media/:kind/:entityId/:variant` | Media bằng validated ID, không nhận raw path |
| GET | `/api/v2/jobs/:id/scenes/:sceneId/download` | ZIP chỉ chứa scene pack tương ứng |
| GET | `/api/v2/jobs/:id/download` | ZIP toàn bộ video asset pack |
| POST | `/api/v2/jobs/:id/scenes/:sceneId/reanalyze` | Re-analyze một scene và rebuild asset pack |
| POST | `/api/v2/jobs/:id/assets/:assetId/feedback` | Ghi feedback editor gồm utility, download intent, time saved và artifact rating |
| GET | `/api/v2/jobs/:id/feedback` | Lấy feedback cùng aggregate theo asset type/extraction mode |

Job v1 tiếp tục dùng các endpoint legacy read-only trong [deprecation plan](docs/DEPRECATION-v1.md). Không diễn giải `sceneClips` v1 thành scene v2.

## Provider contracts

`SEGMENTER_ENDPOINT` nhận JSON có ảnh crop base64, kích thước và prompt; trả `maskBase64`, `confidence`, `provider`, `version`.

`INPAINTER_ENDPOINT` nhận ảnh, mask vùng thiếu và prompt; trả `imageBase64`, `provider`, `version`.

Nếu endpoint lỗi:

- segmentation có thể fallback sang local border matte;
- background recovery ưu tiên pixel thật từ keyframe khác, sau đó mới dùng inpainting;
- local inpainting chỉ chạy khi background recovery được bật và luôn mang mode `RECONSTRUCTED`.

Chi tiết quyết định nằm trong [ADR provider](docs/adr/0002-provider-boundaries.md).

## Cấu hình

`.env.example` là danh sách canonical. Kiểm tra độ lệch:

```powershell
npm.cmd run check:config
```

Nhóm chính:

- ingestion: `MAX_VIDEO_DURATION_SEC`, `MAX_UPLOAD_MB`;
- scene/keyframe budgets: `MIN_SCENE_DURATION_SEC`, `MAX_SCENE_DURATION_SEC`, `MAX_SCENES`, `KEYFRAMES_PER_SCENE`, `MAX_KEYFRAMES_PER_SCENE`, `MAX_TOTAL_KEYFRAMES`;
- Vision: `VISION_MODEL`, image/retry/timeout settings, `ANTHROPIC_API_KEY`;
- Vision hard caps: `MAX_VISION_IMAGE_BYTES_PER_SCENE`, `MAX_VISION_PIXELS_PER_SCENE`;
- segmentation: `ENABLE_SEGMENTATION`, `SEGMENTER_*`, provider version và `MAX_SEGMENTATION_CALLS`;
- reconstruction: `ENABLE_BACKGROUND_RECOVERY`, `INPAINTER_*`, provider version và `MAX_INPAINT_AREA_RATIO`;
- quality/dedupe: `ASSET_MIN_QUALITY`, `ASSET_REVIEW_QUALITY`, `ASSET_DEDUPE_HAMMING`;
- resource/security/retention: `MAX_JOB_DISK_MB`, `MAX_PIPELINE_RUNTIME_SEC`, `API_KEY`, rate limit và `ASSET_RETENTION_HOURS`.

Các config frame/candidate/clip cũ được giữ để đọc hoặc chạy compatibility pipeline v1, không điều phối pipeline v2.

Segmentation và inpainting cache nằm trong vùng cache riêng của scene, khóa theo source/crop/provider version. Re-analyze có thể rebuild thư mục output mà không gọi lại provider khi cache còn hợp lệ.

## Test và evaluation

PowerShell trong một số máy chặn `npm.ps1`; dùng `npm.cmd`.

```powershell
npm.cmd run test:serial
npm.cmd run check:config
npm.cmd run baseline:legacy
npm.cmd run evaluate
npm.cmd run benchmark:providers -- --dry-run
```

`npm.cmd test` dùng Node test runner song song. Nếu môi trường Windows sandbox không cho test runner spawn child process, `test:serial` chạy từng file trực tiếp.

Editor acceptance dùng template có sẵn, giữ rating mới nhất của từng cặp reviewer/asset và kiểm tra các threshold trong ground truth:

```powershell
Copy-Item test/fixtures/decomposer/editor-acceptance-template.json editor-review.json
# Điền review thật vào editor-review.json
npm.cmd run acceptance:summary -- editor-review.json --output test-results/editor-acceptance/report.json
```

Live provider benchmark mặc định không gọi API. `--live` chỉ được phép chạy khi có thêm `--confirm-api-cost`; mọi output đã sanitize được ghi dưới `test-results/live-providers/`. Có hard cap cho scene, keyframe, tổng image bytes và API request. Token pricing là dữ liệu tùy chọn do người chạy cung cấp, không được hard-code:

```powershell
# Chỉ chạy sau khi đã phê duyệt chi phí API:
npm.cmd run benchmark:providers -- --live --confirm-api-cost --max-scenes 3 --max-keyframes-per-scene 3 --max-image-bytes 8388608 --max-api-requests 3
```

Khi ground truth vẫn là `pending-human-editor-review`, report có thể chứa số đo sơ bộ nhưng luôn đặt `releaseGateClaimed: false`; công cụ không diễn giải chúng thành kết quả benchmark đã được review. Editor acceptance cũng yêu cầu mọi input mang trạng thái `human-editor-reviewed` trước khi release gate có thể pass.

Benchmark/threshold, ADR và baseline:

- [Ground truth synthetic](test/fixtures/decomposer/ground-truth.json)
- [Baseline](docs/BASELINE-video-scene-decomposer.md)
- [Implementation audit](docs/REPORT-video-scene-decomposer-implementation.md)
- [PLAN completion audit](docs/AUDIT-video-scene-decomposer-plan.md)
- [Scene semantics](docs/adr/0001-scene-semantics.md)
- [Provenance/quality](docs/adr/0003-asset-provenance-quality.md)

## Giới hạn

- Video đã render là output phẳng; hệ thống không thể cam kết khôi phục layer gốc chính xác.
- Segmentation/inpainting local fallback ưu tiên deterministic development, không thay thế provider production-quality.
- Background reconstruction mặc định tắt.
- Source discovery/reverse-image search nằm ngoài MVP.
- Công cụ không khẳng định asset là copyright-free. Trích xuất kỹ thuật không đồng nghĩa quyền tái sử dụng.
- Queue vẫn single-flight và single-instance; distributed scaling chưa thuộc phạm vi hiện tại.
