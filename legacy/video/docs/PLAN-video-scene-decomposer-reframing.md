# Kế hoạch định hình lại dự án thành Video Scene Decomposer

## 1. Mục đích và phạm vi của kế hoạch

Tài liệu này là kế hoạch kỹ thuật để chuyển dự án hiện tại từ công cụ tìm và xuất các frame tĩnh có vẻ là “inserted visual asset” thành công cụ phân rã video theo scene, nhận diện các element hữu ích cho editor, rồi trích xuất hoặc tái dựng chúng thành asset có thể tái sử dụng.

Nguồn yêu cầu sản phẩm là `video_scene_decomposer_project_reframing.md`. File đó được dùng như đặc tả mục tiêu, không được xem là lệnh yêu cầu sửa code trong lượt lập kế hoạch này.

Phạm vi của kế hoạch:

- Giữ lại hạ tầng ingestion, job, queue, persistence, cleanup và download đang có nếu không cần viết lại.
- Thay trọng tâm pipeline từ frame/candidate sang scene/element/asset.
- Xác định đầy đủ migration dữ liệu, API, UI, kiểm thử và tiêu chí chất lượng.
- Ưu tiên một MVP thật sự tạo được asset hữu ích cho editor.
- Chưa triển khai source discovery, distributed workers hoặc multi-user scaling.

Kế hoạch này không sửa mã nguồn hiện tại.

---

## 2. Kết luận sau khi đọc hiện trạng

### 2.1 Pipeline thực tế đang có

Pipeline chính hiện nằm trong `src/routes/extractRoutes.js` và vận hành như sau:

```text
YouTube URL / upload
  -> validate + local video
  -> sample toàn video theo SAMPLE_FPS
  -> ưu tiên freezedetect, thiếu tín hiệu thì fallback scene cut
  -> dHash/chroma dedupe các frame liên tiếp
  -> chọn frame sắc nét nhất mỗi nhóm
  -> Claude Vision phân loại từng frame là inserted asset hay không
  -> copy nguyên full-frame PNG làm asset
  -> cắt clip quanh asset và một số scene clip độc lập
  -> tạo thumbnail + flat manifest + gallery + ZIP
```

Đây vẫn là một frame extractor có bước lọc semantic. Scene hiện chỉ xuất hiện như clip tham khảo ở cuối pipeline; scene không phải entity điều phối phân tích.

### 2.2 Những phần đã có giá trị và nên giữ

| Năng lực hiện tại | Thành phần | Hướng xử lý |
|---|---|---|
| YouTube download | `downloadService.js` | Giữ, chỉ bổ sung metadata/error nếu cần |
| Upload, extension, size, duration guard | `upload.js`, `ingestionService.js` | Giữ và mở rộng video metadata |
| FFmpeg/ffprobe wrappers | `utils/ffmpeg.js`, `videoInfo.js` | Giữ, tách thêm primitive cho scene/keyframe |
| Job lifecycle và progress | `jobService.js`, `extractRoutes.js` | Giữ API nền, thay stage graph và schema job |
| Single-flight queue | `pipelineQueue.js` | Giữ cho MVP; chưa scale sớm |
| SQLite persistence | `db.js` | Giữ; thêm versioning/migration trước khi đổi schema |
| Cleanup/retention | `cleanupService.js` | Giữ; cập nhật cây thư mục và trạng thái được bảo vệ |
| Retry/cost guard của Vision | `visionService.js` | Giữ cơ chế, thay contract từ frame classification sang scene analysis |
| Thumbnail, staging, atomic finalize, ZIP | `assetExtractionService.js`, `assetRoutes.js` | Tái sử dụng pattern, thay output và manifest |
| History, polling, auth, rate limit | frontend + middleware | Giữ hành vi nền |
| Scene-cut primitive và clip cutting | `candidateService.js`, `clipService.js` | Tách/promote thành scene detection service; không dùng scene như clip phụ |

### 2.3 Khoảng cách giữa hiện trạng và đích đến

| Chủ đề | Hiện trạng | Mục tiêu | Mức lệch |
|---|---|---|---|
| Đơn vị trung tâm | Candidate frame phẳng | Scene chứa keyframes, elements, tracks, assets | Cần đổi mô hình lõi |
| Scene detection | Fallback khi freeze yếu; scene clip bị cap và ưu tiên scene dài | Stage P0 độc lập, phủ toàn video, xử lý cut/fade/transition | Cần viết lại |
| Keyframes | Một representative frame của nhóm hash | 3–5 keyframes/scene theo thông tin, visibility, sharpness, motion | Chưa có |
| AI understanding | Mỗi frame hỏi có phải inserted asset không | Phân tích nhiều keyframe cùng scene, taxonomy theo mental model của editor | Cần thay prompt/schema |
| Element localization | Không có bbox/mask | Element có bbox theo từng observation, loại, extractability, occlusion | Chưa có |
| Temporal association | Dedupe frame liên tiếp | Track cùng element qua nhiều keyframe/scene | Chưa có |
| Foreground extraction | Copy nguyên frame | Segmentation/matting thành RGBA, edge cleanup | Chưa có |
| Background recovery | Không có | Remove foreground + inpainting + generated-area metadata | Chưa có |
| Reconstruction | Không có | Optional, công khai phần pixel tái dựng | Chưa có |
| Text/graphics | Chỉ có label chung | OCR, bbox, crop; metadata style tối thiểu | Chưa có |
| Asset states | Một PNG toàn frame | EXACT/DIRECT, SEGMENTED, RECONSTRUCTED, FAILED | Chưa có |
| Quality | Confidence của AI classifier | Quality tổng hợp visibility/resolution/blur/occlusion/mask/reconstruction | Chưa có |
| Deduplication | dHash nhóm frame liên tiếp | Scene-local track + cross-scene/video asset dedupe | Chưa có |
| Manifest | Flat assets + scene clips | Scene-centered manifest, provenance và occurrence | Cần schema v2 |
| UI | Asset grid trước, scene clips là section phụ | Timeline scene-first, scene detail, element gallery/filter/mode/quality | Cần thiết kế lại |
| Evaluation | Job pass và fixture kỹ thuật | Boundary F1, element precision/recall, mask quality, utility | Chưa có benchmark |

### 2.4 Các vấn đề cụ thể phải xử lý trong quá trình chuyển đổi

1. `candidateService` lấy static span làm tín hiệu chính nên bỏ sót zoom, pan, motion graphics, scrolling screenshot và moving subject.
2. `clipService.detectSceneSegments()` chỉ dựa hard cut, loại segment ngắn và cap theo scene dài nhất; vì vậy không bảo toàn partition đầy đủ của video.
3. Scene detection bị thực hiện hai lần với hai mục đích khác nhau: fallback candidate và clip output. Hai kết quả không tạo thành một nguồn dữ liệu canonical.
4. Vision prompt cố ý loại person, background, B-roll và ordinary footage, trong khi đó lại là những loại element mới cần phát hiện.
5. Vision nhận các frame rời rạc, không biết các ảnh thuộc scene nào, nên không thể suy luận occlusion, best observation hay element persistence.
6. `assetExtractionService` copy nguyên candidate PNG; tên “asset” hiện chưa đồng nghĩa với element độc lập có thể reuse.
7. Job/serializer/manifest không có `scenes`, `keyframes`, `elements`, `tracks`, extraction mode, quality hay reconstruction ratio.
8. Asset route chỉ allowlist naming phẳng `asset_NNN`; cấu trúc scene pack mới cần media routing an toàn theo ID/variant.
9. Source video bị xóa ngay sau khi clip stage hoàn tất. Pipeline mới cần source đến hết tracking, segmentation và reconstruction; lifecycle phải được dời về sau.
10. README ghi Node >=18 nhưng `node:sqlite` cần runtime mới hơn; phải chuẩn hóa runtime trước migration.
11. `.env.example` chưa phản ánh các clip setting đã có trong `config.js`; config mới cần một registry/schema duy nhất để tránh lệch tài liệu.
12. Test hiện chủ yếu xác nhận shape/flow của frame pipeline. Nếu giữ nguyên các assertion đó làm đích sản phẩm, dự án sẽ tiếp tục tối ưu sai mục tiêu.

---

## 3. Kiến trúc đích cho MVP

### 3.1 Stage graph

```text
INGESTING
  -> PROBING
  -> DETECTING_SCENES
  -> SELECTING_KEYFRAMES
  -> UNDERSTANDING_SCENES
  -> ASSOCIATING_ELEMENTS
  -> EXTRACTING_DIRECT_ASSETS
  -> SEGMENTING
  -> RECOVERING_BACKGROUNDS (nếu bật)
  -> VALIDATING_ASSETS
  -> DEDUPLICATING
  -> PACKAGING
  -> DONE / FAILED / PARTIAL
```

Mỗi stage phải có input/output contract riêng, artifact có thể kiểm tra và metric riêng. Không gộp scene understanding, segmentation và reconstruction vào một prompt AI duy nhất.

### 3.2 Mô hình dữ liệu canonical v2

```json
{
  "schemaVersion": 2,
  "videoId": "uuid",
  "video": {
    "duration": 120.2,
    "width": 1920,
    "height": 1080,
    "fps": 29.97
  },
  "scenes": [
    {
      "sceneId": "scene_001",
      "start": 0.0,
      "end": 5.4,
      "boundaryIn": { "type": "video_start", "confidence": 1.0 },
      "boundaryOut": { "type": "hard_cut", "confidence": 0.93 },
      "previewKeyframeId": "kf_002",
      "keyframes": [
        {
          "keyframeId": "kf_001",
          "timestamp": 0.25,
          "reason": ["scene_start", "composition_change"],
          "sharpness": 231.4,
          "motion": 0.12,
          "path": "internal-only"
        }
      ],
      "elements": [
        {
          "elementId": "element_001",
          "trackId": "track_001",
          "type": "character",
          "description": "...",
          "extractability": "segmentable",
          "observations": [
            {
              "keyframeId": "kf_002",
              "bbox": [0.05, 0.18, 0.32, 0.76],
              "visibility": 0.92,
              "occlusion": 0.08
            }
          ],
          "assetIds": ["asset_001"]
        }
      ]
    }
  ],
  "tracks": [],
  "assets": [
    {
      "assetId": "asset_001",
      "type": "character",
      "extractionMode": "SEGMENTED",
      "quality": 0.88,
      "sourcePixelsRatio": 1.0,
      "reconstructedAreaRatio": 0.0,
      "occurrences": [{ "sceneId": "scene_001", "elementId": "element_001" }],
      "files": { "primary": "...", "thumbnail": "...", "mask": "..." }
    }
  ]
}
```

Quy tắc dữ liệu:

- Bbox dùng tọa độ normalized `[x, y, width, height]`, origin ở góc trái trên.
- Khoảng thời gian dùng giây, semantics `[start, end)`.
- Mọi ID ổn định trong một lần xử lý; UI/API không dựa vào array index.
- Filesystem path là internal-only và bị serializer loại bỏ.
- `extractionMode` chỉ nhận `DIRECT`, `SEGMENTED`, `RECONSTRUCTED`, `FAILED`.
- Asset có pixel sinh bởi AI phải có `reconstructedAreaRatio > 0` và metadata model/version.
- Full-frame chỉ là scene preview/evidence, không được tự nhận là reusable asset.

### 3.3 Chiến lược persistence và migration

- Thêm `schemaVersion` vào job và manifest ngay Phase 1.
- Trong MVP tiếp tục lưu job JSON trong SQLite để không biến refactor sản phẩm thành dự án database; artifact nặng nằm trên filesystem.
- Không cố migrate kết quả v1 thành “asset thật”. Job cũ được đánh `legacyFrameResult: true`, vẫn xem/download qua compatibility endpoint trong một thời gian xác định.
- API v2 trả scene/element/asset schema mới. API v1 hiện tại được giữ read-only trong giai đoạn chuyển tiếp rồi deprecate.
- Chỉ normalize thành bảng `scenes/elements/assets/occurrences` khi search xuyên nhiều job trở thành requirement đo được.

### 3.4 Ranh giới provider/model

Tạo interface thay vì hard-code một nhà cung cấp cho mọi việc:

- `SceneDetector`
- `KeyframeSelector`
- `SceneAnalyzer`
- `Segmenter`
- `Inpainter`
- `OcrEngine`
- `EmbeddingProvider`
- `AssetValidator`

Phase 0 phải benchmark ít nhất hai lựa chọn cho segmentation/inpainting: dịch vụ API và local worker/model. Quyết định dựa trên chất lượng, latency, chi phí, license, Windows setup và khả năng test deterministic; không bắt buộc nhồi mọi model vào Node process.

---

## 4. Roadmap triển khai chi tiết

## Phase 0 — Baseline, quyết định kỹ thuật và bộ đánh giá

### Mục tiêu

Chốt nghĩa của “scene”, “element hữu ích” và chất lượng đủ dùng trước khi thay pipeline. Đây là hàng rào ngăn dự án tiếp tục tối ưu theo số job hoàn thành thay vì utility.

### Công việc

1. Ghi ADR cho scene semantics:
   - hard cut luôn là boundary;
   - fade/dissolve có một transition interval nhưng phải quy về boundary canonical;
   - thay đổi nội dung nhỏ trong cùng composition không tự động tạo scene;
   - quy tắc cho slideshow, talking head + lower third, screen recording, split screen và motion graphic.
2. Chốt taxonomy MVP: `person`, `character`, `background`, `image`, `screenshot`, `text`, `graphic`; giữ `logo`, `object`, `overlay`, `unknown` trong schema nhưng chưa cam kết extraction đầy đủ.
3. Lập tập benchmark có quyền sử dụng, gồm tối thiểu:
   - hard cuts, fade, dissolve;
   - zoom/pan/scroll;
   - presenter che background;
   - character/object có tóc, glow, motion blur;
   - screenshot, inserted image, text và graphic;
   - negative cases không có asset hữu ích.
4. Tạo ground truth JSON: scene boundaries, key reusable elements, bbox/mask với subset, asset identity và quality rubric.
5. Ghi baseline của code hiện tại trên dataset: scene recall, element recall, số output full-frame, duplicate rate, latency, disk và Vision calls.
6. Spike provider cho scene transition, multi-image vision, segmentation, matting, inpainting, OCR và embedding; ghi decision matrix.
7. Chuẩn hóa runtime Node thực tế, FFmpeg version và CI matrix.

### Deliverables

- `docs/adr/` cho các quyết định trên.
- `test/fixtures/decomposer/` hoặc một manifest tham chiếu tới dataset ngoài repo.
- Script evaluation không phụ thuộc UI.
- Báo cáo baseline và threshold chất lượng MVP.

### Gate hoàn thành

- Mỗi loại scene/element MVP có ít nhất một positive và một hard/negative sample.
- Ground truth được review thủ công theo mental model của editor.
- Đã chọn được provider hoặc có adapter + fallback rõ ràng cho segmentation/inpainting.
- Không bắt đầu Phase 2 nếu chưa có cách đo missed/false scene boundary.

## Phase 1 — Scene-centered domain model, storage và compatibility

### Mục tiêu

Đưa `Scene`, `Keyframe`, `Element`, `ElementTrack`, `Asset`, `Occurrence` thành mô hình canonical trước khi thay thuật toán.

### Công việc

1. Tách pipeline orchestration khỏi Express route thành `pipelineService`/stage runner; route chỉ validate, create/enqueue và serialize.
2. Định nghĩa schema v2 có validation tại ranh giới stage; không để object tùy ý truyền xuyên pipeline.
3. Thêm stage statuses mới và progress weights; hỗ trợ `PARTIAL` khi một số asset fail nhưng scene analysis còn hợp lệ.
4. Thêm artifact layout:

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
   ```

5. Version job/manifest; serializer v2 loại path và model secret.
6. Giữ adapter đọc job v1. Không diễn giải `sceneClips` cũ thành scene v2.
7. Cập nhật cleanup để bảo vệ toàn bộ job tree và chỉ xóa source sau stage cuối cần video.
8. Bổ sung config schema tập trung để `.env.example`, validation và `/api/config` không lệch nhau.

### Thành phần dự kiến thay đổi

`extractRoutes.js`, `jobService.js`, `db.js`, `serialize.js`, `cleanupService.js`, `config.js`; tạo `domain/`, `pipeline/`, `artifactStore.js`.

### Gate hoàn thành

- Có thể tạo job v2 giả lập gồm scenes/elements/assets, persist qua restart và serialize không leak path.
- Job v1 vẫn xem/download được trong compatibility window.
- Stage retry không làm duplicate scene/asset ID.
- Test migration, schema rejection, restart recovery và cleanup đều pass.

## Phase 2 — Scene detection canonical và scene preview

### Mục tiêu

Phân hoạch toàn bộ video thành scene có thứ tự. Scene detection không còn là fallback hay tiện ích cắt clip.

### Công việc

1. Tách `detectSceneCuts` và `detectSceneSegments` thành `sceneDetectionService` duy nhất.
2. Kết hợp tín hiệu:
   - FFmpeg scene score cho hard cut;
   - fade/dissolve detection;
   - histogram/embedding difference;
   - motion discontinuity;
   - minimum/maximum scene duration chỉ dùng để merge/split có lý do, không âm thầm drop scene.
3. Luôn tạo partition từ `0` đến `duration`; không cap bằng cách bỏ scene. Nếu cần cost cap, dùng sampling/analysis budget chứ không làm mất scene.
4. Merge micro-scenes do flash/transition; lưu raw boundary score và lý do merge để debug.
5. Tạo scene preview, optional low-res clip và metrics per scene.
6. Đưa output scene vào job ngay sau stage để UI có thể hiện partial progress.
7. Xóa việc detect scene lần hai ở clip stage; mọi downstream consumer dùng cùng scene list.

### Gate hoàn thành

- Scene ranges liên tục, không overlap, không gap, scene đầu bắt đầu 0 và scene cuối kết thúc tại duration.
- Đạt threshold boundary precision/recall đã chốt ở Phase 0 trên benchmark.
- Ken Burns/scroll không bị hiểu thành zero-scene; flash ngắn không tạo hàng loạt scene rác.
- Scene clips/previews khớp chính xác scene IDs và range canonical.

## Phase 3 — Keyframe selection theo thông tin trong từng scene

### Mục tiêu

Chọn 3–5 keyframes điển hình cho scene thường và tối đa 8 với scene phức tạp, thay vì một frame theo fixed interval/static group.

### Công việc

1. Sample dày hơn bên trong từng scene nhưng ở độ phân giải proxy để tiết kiệm I/O.
2. Tính feature per sample: sharpness, motion/blur, composition difference, border/black frame, OCR/text change và optional object visibility proxy.
3. Luôn cân nhắc frame đầu/mid/cuối nhưng loại frame transition/blur; chọn thêm local extrema của composition.
4. Dùng diversity clustering để tránh 5 keyframes gần giống nhau.
5. Chọn `previewKeyframe` và ghi `selectionReason` cho từng keyframe.
6. Giữ static/freeze score như một feature, không làm recall gate.
7. Bảo đảm timestamp seek chính xác và frame orientation/color metadata đúng.

### Thành phần dự kiến

Refactor logic hữu ích từ `candidateService.js`; tạo `keyframeSelectionService.js`, mở rộng sharpness/hash utilities.

### Gate hoàn thành

- Mỗi scene hợp lệ có ít nhất một keyframe; scene phức tạp nằm trong budget cấu hình.
- Bộ keyframe cover được các element ground-truth tốt hơn baseline single-frame.
- Transition/black/blur frame rate dưới threshold đã chốt.
- Cost model báo tổng keyframes, pixel gửi Vision và thời gian theo scene.

## Phase 4 — Multi-keyframe scene understanding và element detection

### Mục tiêu

Nhận diện các element theo mental model của editor từ nhiều keyframe cùng scene, kèm bbox, observation, occlusion và extractability.

### Công việc

1. Thay `SYSTEM_PROMPT` và `report_assets` frame classifier bằng scene analyzer contract.
2. Mỗi request chứa scene metadata và keyframes có stable ref; output structured gồm:
   - element type/description;
   - observation theo keyframe với bbox normalized;
   - visibility, occlusion, motion;
   - `direct`, `segmentable`, `requires_inpainting`, `not_extractable`;
   - confidence tách semantic và localization.
3. Validate schema nghiêm ngặt: bbox bounds, unique IDs, ref tồn tại, enum hợp lệ; lưu raw provider metadata để audit nhưng không trả secret.
4. Tạo scene-local association tối thiểu: những observation rõ ràng cùng element được gộp thành một element. Đây chưa phải tracker nâng cao.
5. OCR MVP cho `text` và text nằm trong screenshot/graphic; phân biệt text độc lập với text là nội dung của screenshot.
6. Thêm budget/retry per scene; scene thất bại được retry độc lập và job có thể `PARTIAL`.
7. Cho phép re-analyze một scene mà không chạy lại toàn video.

### Gate hoàn thành

- Element precision/recall theo taxonomy đạt threshold MVP trên benchmark.
- Bbox được đo IoU trên subset ground-truth.
- Person/background không còn bị prompt loại mặc định.
- Cùng element xuất hiện ở nhiều keyframe không tạo output độc lập ngay lập tức.
- Một scene Vision fail không xóa kết quả scene khác.

## Phase 5 — Direct extraction cho image, screenshot, text và graphic

### Mục tiêu

Tạo asset hữu ích đầu tiên mà chưa cần giải bài toán segmentation/reconstruction khó nhất.

### Công việc

1. Với element rectangular/direct, chọn observation có resolution/visibility cao nhất.
2. Crop theo bbox với padding có kiểm soát; hỗ trợ perspective correction khi screenshot/image bị nghiêng.
3. Loại caption/watermark bên ngoài bbox; không tự xóa nội dung nằm bên trong asset nếu không chắc chắn.
4. Với text: xuất crop PNG + OCR content + position + color/alignment/weight estimate tối thiểu.
5. Với graphic: direct crop khi bounding region độc lập; nếu nền lẫn phức tạp chuyển sang segmentation, không gắn nhãn DIRECT sai.
6. Ghi source keyframe, crop transform, original resolution và source-pixel ratio.
7. Cập nhật packager tạo scene folder và manifest v2 atomically.

### Gate hoàn thành

- Screenshot/image ground-truth được crop đủ nội dung, không cắt mép và có độ phân giải dùng được.
- DIRECT asset chỉ chứa pixel từ source; `sourcePixelsRatio = 1`.
- OCR có confidence và không làm job fail khi engine lỗi.
- Full-frame chỉ xuất dưới vai trò scene preview.

## Phase 6 — Foreground segmentation và alpha matting

### Mục tiêu

Xuất person, character và isolated graphic thành PNG RGBA có nền trong suốt.

### Công việc

1. Implement `Segmenter` adapter đã chọn ở Phase 0, nhận bbox/prompt và trả mask + confidence.
2. Chọn best observation trước segmentation dựa visibility, resolution, blur, occlusion và crop completeness.
3. Alpha matting/edge refinement cho tóc, anti-alias, glow, shadow và semi-transparency; giữ cả raw mask và refined mask để debug.
4. Detect foreground contamination, holes và clipped boundary; asset không đạt gate chuyển `FAILED` hoặc cần reconstruction, không âm thầm xuất xấu.
5. Xuất RGBA PNG, mask, thumbnail trên checkerboard và metadata model/version.
6. Cache theo source frame + bbox + provider version để retry/rerun không tốn lại.

### Gate hoàn thành

- Mask IoU/boundary metric đạt threshold trên subset có ground truth.
- Alpha thực sự có transparency và không còn background contamination quá ngưỡng.
- Hair/glow/shadow cases được review visual theo rubric.
- UI/manifest hiển thị `SEGMENTED`, không gọi là original layer.

## Phase 7 — Background recovery và reconstruction có minh bạch

### Mục tiêu

Tạo background có thể dùng lại khi foreground che khuất, đồng thời công khai phần nội dung được sinh/tái dựng.

### Công việc

1. Tổng hợp foreground masks từ các observations trong scene.
2. Ưu tiên temporal recovery: lấy pixel thật từ keyframe khác bằng alignment/warping trước khi dùng generative inpainting.
3. Chỉ inpaint phần còn thiếu sau temporal merge; lưu generated-region mask.
4. Tính `reconstructedAreaRatio`, source pixel ratio, seam/artifact score và provider metadata.
5. Đặt ngưỡng không reconstruction nếu missing area quá lớn hoặc scene có camera motion không align được.
6. Làm reconstruction optional theo config/UI; không bắt buộc để job MVP direct/segmented hoàn tất.
7. Quy tắc naming/label luôn ghi `RECONSTRUCTED` và cảnh báo approximation.

### Gate hoàn thành

- Không asset nào có pixel sinh mà mang mode DIRECT/SEGMENTED.
- Reconstruction mask và ratio khớp pixel đã thay đổi trong sai số định trước.
- Cases không thể phục hồi trả failure reason rõ, không tạo hình “có vẻ đẹp” nhưng sai provenance.
- Background utility được editor review riêng với artifact rubric.

## Phase 8 — Temporal tracking, best-frame fusion và dedupe xuyên scene

### Mục tiêu

Nhận ra cùng element qua nhiều keyframe/scene, tận dụng observation tốt nhất và không xuất duplicate.

### Công việc

1. Scene-local tracking dựa bbox overlap, embeddings, appearance và temporal adjacency.
2. Cross-scene identity matching thận trọng; tách `track` trong scene khỏi `asset identity` xuyên video.
3. Best-frame/fusion: chọn hoặc kết hợp observation để giảm occlusion, không làm mất provenance.
4. Dedupe asset bằng embedding + perceptual hash + mask/shape similarity + type; dHash một mình không đủ.
5. Lưu occurrence list theo scene/time thay vì nhiều file trùng.
6. Thêm human-safe threshold: uncertain pairs không merge; có debug reason/similarity score.
7. Hỗ trợ sửa merge/split trong UI ở mức metadata nếu sản phẩm cần review loop.

### Gate hoàn thành

- Duplicate-kept và false-merge rate đạt threshold benchmark.
- Một character lặp lại có một asset identity và nhiều occurrences.
- Hai element giống màu/bố cục nhưng khác nội dung không bị nhập nhầm.
- Rerun deterministic với cùng provider/version và threshold.

## Phase 9 — Quality scoring và asset validation

### Mục tiêu

Xếp hạng theo khả năng sử dụng thực tế, không dùng Vision confidence như quality score.

### Công việc

1. Xây quality vector: resolution, sharpness, visibility, occlusion, semantic confidence, localization confidence, mask quality, edge contamination, reconstruction ratio và artifact score.
2. Hiệu chỉnh score theo từng type/mode; background và text không dùng chung trọng số với character.
3. Định nghĩa `usable`, `review`, `failed` threshold; giữ component scores để giải thích.
4. Asset validator kiểm tra file integrity, alpha, dimension, empty crop/mask, metadata/file consistency.
5. Rank assets trong scene và toàn video; ẩn failed khỏi gallery mặc định nhưng giữ diagnostic.
6. Thu thập feedback “downloaded/useful/not useful” cho calibration tương lai, không tự tuyên bố copyright-free.

### Gate hoàn thành

- Asset xấu có xu hướng đứng dưới asset tốt theo editor review.
- Score có thể giải thích từ component, không phải một confidence mơ hồ.
- Manifest/file invariant được kiểm tra trước khi publish atomically.
- Job chỉ `DONE` sau package validation; lỗi cục bộ hợp lệ thành `PARTIAL`.

## Phase 10 — Scene-first API, UI và asset packs

### Mục tiêu

Đưa scene/element/asset thành workflow chính cho editor.

### API dự kiến

- `GET /api/v2/jobs/:id` — job/video summary và stage progress.
- `GET /api/v2/jobs/:id/scenes` — timeline scene summaries.
- `GET /api/v2/jobs/:id/scenes/:sceneId` — keyframes/elements/assets của scene.
- `GET /api/v2/jobs/:id/assets?type=&mode=&minQuality=` — library/filter.
- `GET /api/v2/jobs/:id/scenes/:sceneId/download` — scene asset pack.
- `GET /api/v2/jobs/:id/download` — toàn bộ video asset pack.
- Media route dùng validated IDs + variant, không nhận raw filesystem path.

### UI công việc

1. Timeline scene theo thứ tự thời gian, có selected scene và range.
2. Scene preview + keyframe strip để người dùng hiểu evidence.
3. Element gallery theo taxonomy; card có type, mode, quality, resolution và download.
4. Filter theo type/mode/quality; mặc định ưu tiên reusable assets, không ưu tiên full-frame.
5. Preview transparency, reconstruction overlay/mask và cảnh báo generated pixels.
6. Download từng asset, scene pack và toàn bộ pack.
7. History v2 phân biệt legacy frame result với decomposer result.
8. Accessibility, responsive, safe text rendering và polling/resume hiện tại phải được giữ.
9. Hiển thị copyright/reuse notice: kỹ thuật trích xuất không đồng nghĩa quyền tái sử dụng.

### Export layout

```text
video_asset_pack/
  manifest.json
  scene_001/
    scene_preview.jpg
    keyframes/
    assets/
      character_001.png
      character_001_mask.png
      background_001.png
      screenshot_001.png
      text_001.png
    metadata.json
```

### Gate hoàn thành

- User đi được flow: chọn video → chọn scene → xem elements → download asset.
- Scene pack chỉ chứa asset của scene; full pack có occurrence/dedupe metadata đúng.
- UI phân biệt DIRECT/SEGMENTED/RECONSTRUCTED bằng text, không chỉ màu.
- Không endpoint nào leak path, key, raw provider response hoặc file ngoài allowlist.

## Phase 11 — Hardening, performance, documentation và MVP release gate

### Mục tiêu

Đảm bảo pipeline mới ổn định và đo được trước khi coi là bản sản phẩm mạnh đầu tiên.

### Công việc

1. Integration tests cho cả URL/upload qua pipeline mock provider và fixture thật.
2. Contract tests cho mọi adapter; chaos test timeout, 429, malformed output, corrupt media, disk full và restart.
3. Rerun/retry theo scene/stage; idempotent artifact writes và cleanup staging.
4. Resource budgets: max scenes, keyframes, pixels/API call, segmentation calls, inpainting area, disk và runtime.
5. Structured logs/metrics theo `jobId`, `sceneId`, stage, provider/version, cost và failure code.
6. Security audit cho upload, SSRF/URL handling, media routes, ZIP, API key, rate limit và untrusted model text.
7. Cập nhật README, hướng dẫn hoạt động và `.env.example` theo pipeline mới; sửa yêu cầu Node runtime.
8. Deprecation plan cho API/UI v1 và thời điểm xóa compatibility code.
9. Editor acceptance test: người dùng thật đánh dấu asset nào họ sẽ download/reuse và thời gian tiết kiệm.

### MVP release gate

- Scene boundary và element metrics đạt target từ Phase 0.
- Person/character, background, image/screenshot, text/graphic đều có ít nhất một end-to-end success case.
- DIRECT/SEGMENTED/RECONSTRUCTED provenance luôn đúng.
- Không silently drop scene; mọi failure có status/reason.
- Editor có thể tìm và tải ít nhất một asset thực sự hữu ích từ benchmark video.
- Latency/cost nằm trong budget công bố và không cần distributed infrastructure.

---

## 5. Thứ tự release đề xuất

### Milestone A — Scene foundation

Gồm Phase 0–3. Kết quả chưa cần asset đẹp, nhưng hệ thống phải hiển thị đúng scene, keyframes và element boxes. Đây là điểm kiểm tra xem mental model đã thật sự đổi hay chưa.

### Milestone B — Useful extraction MVP

Gồm Phase 4–6 và phần validation cơ bản của Phase 9. Tập trung tạo image/screenshot crop và person/character RGBA dùng được. Có thể chưa bật background reconstruction mặc định.

### Milestone C — Decomposer MVP

Gồm Phase 7–10. Có background recovery, occurrence/dedupe, quality score, scene-first UI và asset packs.

### Milestone D — Production-ready single-instance

Phase 11. Vẫn giữ single-flight/single-instance nếu đáp ứng workload; chưa mở rộng distributed worker chỉ để “trông production”.

---

## 6. Dependency và critical path

```text
Evaluation/ADR
  -> Domain model v2
  -> Scene detection
  -> Keyframes
  -> Scene understanding + observations
       -> Direct extraction --------------------┐
       -> Segmentation -> Background recovery --┤
       -> Tracking/dedupe -----------------------┤
                                                -> Quality/validation
                                                -> Scene-first API/UI/export
                                                -> Release hardening
```

Không nên bắt đầu các việc sau quá sớm:

- UI scene-first trước khi scene/element schema ổn định.
- Background inpainting trước khi foreground mask đủ tốt.
- Cross-scene dedupe trước khi element observations có identity và embeddings.
- Source discovery trước khi asset extraction có utility tốt.
- Distributed queue/storage trước khi đo thấy single-instance là bottleneck.

---

## 7. Kế hoạch kiểm thử và đánh giá xuyên suốt

### 7.1 Test pyramid

- Unit: parser, time range, bbox validation, score, matching, schema migration.
- Contract: Vision/segmenter/inpainter/OCR adapter với mock và malformed responses.
- Media fixture: scene partition, keyframe selection, crop, alpha, reconstruction masks.
- Pipeline integration: upload/URL mock, stage retry, partial success, persistence/restart.
- API/security: path traversal, ID validation, status semantics, ZIP integrity, secret/path leak.
- UI runtime/browser: timeline, scene selection, filters, safe text, downloads, responsive/accessibility.
- Human evaluation: editor utility và visual artifact review.

### 7.2 Metrics bắt buộc

| Stage | Metric chính |
|---|---|
| Scene detection | boundary precision/recall/F1 và tolerance |
| Keyframes | element coverage, redundancy, blur/transition rate |
| Element detection | precision/recall theo type, bbox IoU |
| Tracking/dedupe | ID switches, duplicate-kept, false-merge |
| Segmentation | mask IoU, boundary F-score, contamination |
| Reconstruction | generated ratio, artifact rating, temporal consistency |
| Quality rank | correlation với editor rating/download intent |
| Product | asset download/reuse intent và thời gian tiết kiệm |

### 7.3 Quy tắc regression

- Ingestion, upload guard, queue, persistence, cleanup, auth và path security hiện có phải tiếp tục pass.
- Test cũ khẳng định frame là output chính cần được chuyển thành legacy compatibility test, không dùng làm tiêu chí kiến trúc mới.
- Mỗi bug visual phải có fixture/annotation trước hoặc cùng lúc với fix.
- Provider model/version và threshold phải được ghi vào evaluation report để so sánh công bằng.

---

## 8. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Hậu quả | Giảm thiểu |
|---|---|---|
| Scene definition mơ hồ | Metrics và UI không ổn định | ADR + annotated benchmark trước coding |
| Multi-image Vision bbox thiếu chính xác | Crop/mask sai | Schema validation, localization benchmark, detector/segmenter refinement |
| Segmentation edge xấu | Asset không dùng được | Alpha matting, edge metrics, visual gate, provider abstraction |
| Inpainting “đẹp nhưng sai” | Người dùng hiểu nhầm là original | Generated mask/ratio, explicit mode, optional stage |
| Cost tăng theo scene/keyframe | Pipeline đắt/chậm | Budget per video/scene, proxy frames, cache và selective reconstruction |
| Job JSON phình lớn | SQLite read/write chậm | Chỉ metadata trong DB, artifact trên disk; normalize khi đo thấy cần |
| Migration làm mất job cũ | Mất history/download | schema version + read-only v1 adapter + deprecation window |
| Source bị xóa quá sớm | Không thể chạy downstream | Artifact lifecycle theo last consumer; chỉ cleanup sau packaging |
| Provider outage/malformed output | Job fail toàn bộ | Retry per scene, partial status, resumable stage, contract tests |
| Copyright messaging không rõ | Người dùng hiểu sai quyền reuse | Disclaimer trong UI/manifest; không gắn nhãn copyright-free |

---

## 9. Những phần bị hoãn có chủ đích

Không thuộc MVP decomposer:

- Tìm “original source” bằng reverse image search.
- Khẳng định provenance hoặc license khi chưa xác minh.
- Tái tạo project Premiere/After Effects hay animation curve.
- Nhận diện font hoàn hảo hoặc dựng text thành editable layer đầy đủ.
- Phục hồi pixel ngoài khung hình với cam kết chính xác.
- Mọi loại object taxonomy chi tiết.
- Multi-user, distributed worker, object storage và horizontal scaling.

Source discovery chỉ được mở thành roadmap riêng sau khi Milestone C đạt quality/utility gate. Kết quả của module đó phải dùng ngôn ngữ “possible source” hoặc “visually similar source”.

---

## 10. Checklist hoàn tất toàn bộ chuyển đổi

- [x] Job/manifest/API dùng schema v2 scene-centered.
- [x] Scene là partition canonical và điều phối mọi stage downstream.
- [x] Mỗi scene có keyframes đa dạng, có lý do chọn.
- [x] Scene analyzer trả element observations từ nhiều keyframe.
- [x] Có direct crop cho image/screenshot/text/graphic.
- [x] Có RGBA segmentation cho person/character.
- [x] Background recovery công khai vùng reconstructed.
- [x] Có tracks/occurrences và dedupe xuyên scene.
- [x] Asset quality không đồng nhất với AI confidence.
- [x] UI bắt đầu từ timeline/selected scene và element gallery.
- [x] Scene pack/full pack có manifest và provenance đúng.
- [x] Legacy result được phân biệt rõ và có migration/deprecation plan.
- [x] Evaluation đo extraction quality và editor utility, không chỉ job success.
- [x] README/runtime/config phản ánh đúng code.
- [x] Source discovery vẫn nằm ngoài MVP.

Khi checklist này hoàn tất, dự án mới thực sự chuyển từ “tìm frame đáng chú ý” sang “hiểu scene và khôi phục reusable visual elements”.

### Trạng thái xác minh ngày 2026-09-02

Checklist trên phản ánh phạm vi **triển khai kỹ thuật trong repository**. Bằng chứng chi tiết nằm trong
`AUDIT-video-scene-decomposer-plan.md`; lần chạy lại gần nhất đạt 84/84 automated tests, config registry
56/56 keys, scene boundary F1 = 1.0 và toàn bộ synthetic extraction gates đều pass.

Các release gate sau vẫn cố ý để mở vì không thể được xác nhận trung thực chỉ bằng code hoặc dữ liệu giả lập:

- [ ] Editor duyệt thủ công scene semantics và ground-truth annotations.
- [ ] Editor chấm utility/download intent đạt threshold đã công bố.
- [ ] Chạy benchmark Anthropic thật trên ground truth đã được duyệt.
- [ ] Review trực quan segmentation provider production cho hair/glow/shadow/motion blur.
- [ ] Review trực quan inpainting production cho artifact và temporal consistency.
- [ ] Công bố latency/API cost từ lần chạy live có xác nhận chi phí.

Cho đến khi sáu gate này hoàn tất, có thể coi việc chuyển đổi kiến trúc và MVP engineering là hoàn thành,
nhưng chưa được tuyên bố production release.
