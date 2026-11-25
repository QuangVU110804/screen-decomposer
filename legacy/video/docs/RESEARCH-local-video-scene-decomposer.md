# Research: Video Scene Decomposer không dùng API AI bên ngoài

Ngày kiểm tra: 23/10/2026. Phạm vi phiên này: research mục 5; không refactor, thay provider hay sửa UI. Đây là đánh giá từ source dự án và tài liệu/code upstream, chưa phải benchmark chạy model trên máy này.

## Kết luận để ra quyết định

**Có thể xây dựng pipeline local không cần Claude/API AI trả phí. Trong các repo đã khảo sát, chưa xác minh được repo nào thay trực tiếp toàn bộ Video → Scene → Element → Asset pack hiện tại.** Cách khả thi là ghép các thành phần chuyên biệt.

Ưu tiên thử nghiệm **Florence-2 + SAM 2.1 + PaddleOCR**, giữ FFmpeg và phần đóng gói hiện có. Dùng **Qwen3-VL nhỏ chạy local** khi cần hiểu composition sâu hơn. Đánh giá **SAM 3.1** như phương án detect/segment/track mới hơn nếu phần cứng và điều kiện weights phù hợp. Đây là đề xuất kỹ thuật cần được kiểm chứng trên video thực của người dùng.

Không cần API AI bên ngoài không có nghĩa là không dùng AI: model được tải về và suy luận trên máy. Vẫn có chi phí RAM/VRAM, thời gian xử lý, điện và bảo trì. Nếu yêu cầu không dùng AI hoàn toàn, chỉ có thể cung cấp một tập chức năng hẹp hơn như chia shot, chọn frame, crop thủ công và xử lý ảnh truyền thống.

## 1. Bài toán thực tế trong source

Đối chiếu `TOM-TAT-DU-AN.md`, README, đặc tả reframing và các module runtime trong `src/` cho thấy:

| Thành phần hiện tại | Bằng chứng source | Ý nghĩa khi thay Claude |
|---|---|---|
| Scene understanding | `src/services/sceneAnalysisService.js`: `anthropicAnalyze`, `REPORT_SCENE_TOOL`, `normalizeAnalysis` | Nhận nhiều keyframe, trả summary, element type, mô tả, observations, bbox, corners, occlusion, extractability. Thay bằng caption đơn giản sẽ thiếu dữ liệu. |
| Pipeline | `src/pipeline/pipelineService.js`: `runDecomposer`, `extractAssets` | Understanding nằm sau scene/keyframe và trước association/extraction. Có thể thay riêng bước này. |
| Segmentation | `src/services/segmentationService.js`: `endpointSegment`, `localSegment` | Đã có HTTP adapter; local fallback là border-color matte, không phải SAM. |
| Background | `src/services/backgroundRecoveryService.js`: `temporalRecover`, `localInpaint` | Ưu tiên keyframe khác; fallback là blur-fill. Không phải phục hồi layer gốc. |
| OCR | `src/services/ocrService.js`: `fallbackResult` | Mặc định lấy chữ từ scene analyzer; bỏ Claude phải bổ sung OCR hoặc chấp nhận mất năng lực này. |
| Tracking | `src/services/elementAssociationService.js`: `associateElements` | Ghép token mô tả, bbox và khoảng cách scene; chưa phải tracking mask qua mọi frame. |
| Embedding | `src/services/embeddingService.js`: `localEmbedding` | Hash token văn bản 64 chiều, chưa phải visual embedding học được. |
| Contracts | `src/domain/providerContracts.js`, ADR 0002 | Có ranh giới analyzer/segmenter/OCR/embedding; vẫn cần adapter và wiring production, không chỉ đổi tên model trong env. |

Phần media gọi FFmpeg qua child process; xử lý ảnh dùng Sharp. Do đó research này không có căn cứ để kết luận JavaScript tự nó khiến dự án không tối ưu. Việc đánh giá ngôn ngữ, profiling và refactor thuộc phiên khác theo phạm vi người dùng yêu cầu.

Điểm khó nhất là phân biệt screenshot/image/graphic/overlay, chữ nằm trong screenshot với chữ độc lập, và chọn element hữu ích cho editor. Đây không chỉ là bài toán object detection. Shot boundary cũng không đồng nghĩa scene ngữ nghĩa hoặc layer gốc.

## 2. Repo nên xem trước

### A. Grounded-SAM-2 — gần nhất với phần trích element

[Repository](https://github.com/IDEA-Research/Grounded-SAM-2) kết hợp Grounding DINO/Florence-2 với SAM 2; có demo detect, segment, video tracking và continuous ID. Nhánh Florence tự caption → phrase grounding → mask có [source thực](https://github.com/IDEA-Research/Grounded-SAM-2/blob/main/grounded_sam2_florence2_autolabel_pipeline.py).

**Mức phù hợp:** rất đáng thử cho bbox, mask và element foreground. Chưa có schema bảy loại element, quyết định extractability, quality/provenance, dedupe và asset pack theo dự án này; phải tự nối thêm.

**Cần chọn đúng nhánh:** dùng Florence-2 hoặc Grounding DINO weights local. Demo DINO-X và một số Grounding DINO 1.5/1.6 sử dụng cloud/token; không đáp ứng mục tiêu nếu dùng nguyên chúng. Không mặc định toàn repo đều offline. Source demo Florence còn có CUDA call trực tiếp, nên không coi demo đó là CPU-ready chỉ vì có dòng chọn device.

### B. SAM 2.1 — nền tảng mask và tracking

[Repository chính thức](https://github.com/facebookresearch/sam2) hỗ trợ image segmentation, prompt điểm/box/mask và lan truyền mask qua video. Checkpoints/code chính dùng Apache-2.0; repo có thông báo license riêng cho thành phần bổ trợ. Windows được upstream khuyến nghị dùng WSL Ubuntu.

**Mức phù hợp:** thay local border matte; có thể làm tracking trong shot. SAM 2 không tự trả caption hoặc phân loại screenshot/text/graphic. Mask phân vùng cũng chưa bảo đảm alpha mềm chất lượng dựng phim cho tóc, kính, bóng đổ. Không nên gọi một phép xóa nền bằng mask là đã giải quyết toàn bộ matting.

### C. SAM 3 / SAM 3.1 — ứng viên mới cho detect + segment + track

[Repository](https://github.com/facebookresearch/sam3) hỗ trợ prompt khái niệm bằng chữ và hình. [SAM 3.1](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md) bổ sung Object Multiplex cho multi-object tracking.

**Mức phù hợp:** có thể giảm nhu cầu ghép detector riêng khi tìm đối tượng theo prompt. Vẫn cần lớp quyết định element nào đáng trích, OCR và đóng gói.

**Điều kiện:** README yêu cầu Python ≥3.12, PyTorch ≥2.7, GPU CUDA ≥12.6. Weights yêu cầu xin quyền tải và xác thực Hugging Face; đây là token tải model, khác API suy luận trả phí. Dùng SAM License riêng, không gán nhầm Apache-2.0 như SAM 2. Chưa xác nhận RAM/VRAM tối thiểu cho workload này, nên chưa chọn làm mặc định giá rẻ.

### D. VideoContext-Engine — gần luồng hiểu video local

[Repository](https://github.com/dolphin-creator/VideoContext-Engine) ghép chia scene CPU, Whisper local, Qwen3-VL và FastAPI; có đường llama.cpp cho Windows/Linux.

**Mức phù hợp:** tham khảo cách ghép scene → keyframe → mô tả JSON và vòng đời model. Output tập trung transcript/description/tags/summary cho RAG, chưa phải bbox/mask/asset pack. README ghi public beta và Windows/Linux chưa được kiểm thử rộng. Chưa xác minh license tái sử dụng đầy đủ trong phiên này; nên tham khảo kiến trúc trước, chưa sao chép vào sản phẩm.

## 3. Model và thư viện ghép vào pipeline

| Công cụ | Vai trò đề xuất | Giới hạn và kết luận |
|---|---|---|
| [Florence-2](https://huggingface.co/microsoft/Florence-2-base) | Caption, region caption, object detection, grounding, OCR theo task prompt; model card MIT | Hợp làm baseline nhẹ hơn VLM hội thoại lớn. Không nhận nguyên schema Claude và không tự liên kết nhiều keyframe như code hiện tại. Cần mapping và đánh giá riêng. |
| [Qwen3-VL](https://github.com/QwenLM/Qwen3-VL), [4B Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) | Hiểu nhiều ảnh/video local, bổ sung ngữ nghĩa composition | Ứng viên thay vai trò reasoning của Claude; 4B model card Apache-2.0. Bbox/JSON vẫn phải validate; không xem confidence tự khai là xác suất đã hiệu chuẩn. Benchmark 2B/4B trước khi tăng kích thước. |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Phát hiện và đọc text độc lập, dùng OCR local thay text từ Claude | Repo Apache-2.0. Chọn pipeline OCR phù hợp thay vì mặc định bật document VLM. Chữ stylized, nền phức tạp và text lồng screenshot cần dữ liệu đánh giá riêng. |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | Thử tách foreground ảnh tĩnh/crop | Repo MIT. Không thay detector ngữ nghĩa hay tracking nhiều đối tượng; cần tránh crop chứa nhiều foreground khi chỉ muốn một element. |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | Baseline chia shot trên CPU | BSD-3-Clause. So sánh với FFmpeg hiện có; không bắt buộc thay bước đang chạy. Không hiểu element. |
| [TransNetV2](https://github.com/soCzech/TransNetV2) | Shot transition detection bằng model local, có PyTorch inference | Repo MIT. Không cần train lại để infer. Chỉ cân nhắc khi benchmark cho thấy detector hiện tại bỏ sót transition. |

## 4. Repo phân rã layer thực sự và vì sao chưa chọn làm nền tảng MVP

| Repo | Giải quyết điều gì | Đánh giá cho dự án |
|---|---|---|
| [Omnimatte](https://github.com/erikalu/omnimatte) | Object và hiệu ứng liên quan thành layer RGBA | Có code local; phải chuẩn bị mask/flow và train trên video. Hợp nghiên cứu layer/effects, khó thay pipeline asset tự động trên video dài nhiều cut. |
| [Layered Neural Atlases](https://github.com/ykasten/layered-neural-atlases) | Biểu diễn object/background bằng atlas để edit nhất quán | MIT; tối ưu theo video, cần preprocessing mask/flow, dependency cũ. Không phải lấy lại ảnh nguồn/screenshot nguyên bản. |
| [Generative Omnimatte](https://github.com/gen-omnimatte/gen-omnimatte-public) | Tách layer, bóng đổ/phản chiếu và hoàn thiện vùng bị che bằng model sinh | Có public reimplementation dùng CogVideoX/Wan; upstream nói chưa bằng bản Lumiere. Nặng, nhiều bước; code Apache-2.0 nhưng phải kiểm tra thêm license từng backbone/weights. |
| [EasyOmnimatte](https://github.com/GVCLab/EasyOmnimatte) | Hướng diffusion phân rã layer | Khi kiểm tra, README vẫn ghi inference code/checkpoints chưa phát hành và Getting Started Coming Soon. Có paper/demo không đồng nghĩa có thể triển khai ngay. |
| [ProPainter](https://github.com/sczhou/ProPainter) | Video inpainting vùng bị mask, không phải element discovery | Chỉ cân nhắc background recovery nghiên cứu. Upstream ghi non-commercial; không đưa vào mặc định cho sản phẩm thương mại khi chưa giải quyết điều kiện sử dụng. |

Không thể bảo đảm tái dựng pixel chưa từng thấy hoặc project dựng gốc từ video render. Các nhánh generative phải giữ nhãn RECONSTRUCTED và vùng pixel tạo lại; chất lượng nhìn đẹp không biến chúng thành DIRECT.

## 5. Hướng triển khai đáng kiểm chứng

Đây là khuyến nghị sau research, chưa phải thay đổi đã thực hiện hoặc kế hoạch đã được người dùng duyệt.

### Lựa chọn ưu tiên: local chuyên biệt, VLM tùy chọn

1. Giữ ingestion, FFmpeg scene/keyframe, crop, quality, manifest và ZIP hiện có để làm baseline.
2. Florence-2 tạo proposals/bbox/caption từng keyframe; PaddleOCR cung cấp text và vùng chữ.
3. Adapter tổng hợp detections thành element observations. Bbox pixel xyxy từ model phải đổi sang normalized xywh; xử lý offset nếu infer trên crop. Không tự điền corners/occlusion/confidence giả cho field còn thiếu.
4. SAM 2.1 tách object theo bbox; chỉ propagate tracking trong shot/đoạn liên tục cần thiết. Liên kết qua cut là bài toán riêng.
5. Xử lý screenshot/image bằng hình học và crop; giữ khả năng editor chỉnh box/mask cho trường hợp model nhận sai. Không tuyên bố detector đã hiểu đầy đủ bảy loại element.
6. Qwen3-VL local chỉ chạy trên scene khó để phân loại composition hoặc phân biệt overlay với chữ thuộc screenshot. Chuẩn hóa JSON bằng adapter/schema validation, không kỳ vọng tool-use Anthropic tương thích nguyên trạng.
7. Giữ reconstruction tắt trong baseline đầu; thêm sau khi đo được giá trị và chi phí.

Dùng Python worker cho model, Node cho điều phối là lựa chọn phù hợp để tận dụng hệ sinh thái model; không cần viết lại toàn bộ bằng Python chỉ để bỏ API. Localhost HTTP hoặc IPC đều khả thi. Nếu dùng HTTP localhost thì vẫn không gọi API AI bên ngoài; worker phải nạp weights local và không âm thầm fallback cloud.

### Lựa chọn phần cứng

| Điều kiện | Hướng thực tế để thử |
|---|---|
| Chỉ CPU | FFmpeg/PySceneDetect + OCR local + crop/chỉnh thủ công; thử model nhỏ với giới hạn thời gian rõ ràng. Chưa cam kết pipeline tự động đầy đủ nhanh hoặc ngang Claude. |
| Có GPU nhưng VRAM hạn chế | Keyframe/crop trước, thử Florence + SAM nhỏ tuần tự; chỉ nạp model cần dùng. Qwen quantized là ứng viên benchmark, không mặc định chạy được mọi cấu hình. |
| GPU và RAM dư hơn | So sánh baseline với Qwen3-VL 4B/8B và SAM 3.1; đo peak VRAM trước khi chạy đồng thời. |

Chưa có dữ liệu phần cứng/benchmark trong phiên này nên không đưa ra FPS, latency, VRAM tối thiểu hay cam kết chi phí bằng không. Sampling, resolution, số object và context có thể ảnh hưởng lớn hơn kích thước weights đơn thuần.

## 6. Benchmark cần có trước khi quyết định làm lại

Chọn video thật gồm talking-head + screenshot, motion graphics, nhân vật/cartoon, nhiều người, pan/zoom và text tiếng Việt. Bao gồm hard cut, fade, vùng bị che và overlay bán trong suốt. Gán nhãn element hữu ích theo editor, không chỉ mọi object model phát hiện.

So sánh: (A) Florence + SAM 2.1 + OCR; (B) A thêm Qwen cho scene khó; (C) SAM 3.1 + OCR và lớp ngữ nghĩa khi phần cứng cho phép. Dùng cùng scene/keyframe trước để cô lập chất lượng analyzer; sau đó mới so detector shot khác.

Đo precision/recall element theo loại, bbox IoU, mask IoU/boundary, lỗi OCR, sai track, crop mất nội dung và tỷ lệ asset editor dùng được. Đo thêm tổng runtime, runtime theo stage, cold/warm model load, peak RAM/VRAM, disk và số lần cần sửa tay. Có thể tái sử dụng metric từ `scripts/evaluate-decomposer.js`; synthetic fixture hiện có chưa đủ chứng minh chất lượng video thật.

Kiểm tra offline sau khi tải đủ weights/dependencies bằng cách chặn outbound trong một lượt chạy. Model public có thể vẫn tự tải config/tokenizer/weights lần đầu; no external inference và offline từ lần cài đặt đầu là hai yêu cầu khác nhau.

**Chốt research:** xem Grounded-SAM-2 trước để học pipeline element; dùng Florence + SAM 2.1 + OCR làm baseline local; Qwen là lớp ngữ nghĩa tùy tài nguyên; SAM 3.1 là đối chứng mới đáng thử. Các repo Omnimatte phục vụ hướng layer/effects nâng cao, chưa nên trở thành dependency bắt buộc cho bản làm lại chi phí thấp.

## 7. Phạm vi xác minh

- Đã đối chiếu tài liệu dự án, cấu trúc runtime, provider/schema, pipeline và các fallback với nguồn upstream được liên kết ở trên.
- Không đọc/in API key trong `.env`, không gọi Claude hoặc live-provider benchmark, không cài model/clone repo/chạy GPU benchmark.
- Chưa chứng minh bất kỳ model nào đạt chất lượng tương đương Claude trên dữ liệu người dùng. Các khuyến nghị là kết quả research có giới hạn, không phải kết quả triển khai.
- Phiên này chỉ bổ sung báo cáo này; không thực hiện mục 1–4.
