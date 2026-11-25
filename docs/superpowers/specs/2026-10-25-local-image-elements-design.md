# Thiết kế: tự động trích element từ ảnh review anime

Trạng thái: người dùng đã duyệt; triển khai và kiểm thử ngày 26/10/2026. Kết quả/giới hạn nằm trong `docs/REPORT-local-image-elements.md`.
Ngày: 25/10/2026.

## Mục tiêu và phạm vi

Thay workflow video bằng ảnh JPG/PNG/WebP: upload một ảnh, tự động quét toàn ảnh, đề xuất vùng element, xuất các vùng được tìm thấy thành asset có thể tải riêng hoặc ZIP. Không yêu cầu khoanh vùng, click prompt hoặc API key để bắt đầu quét. Chọn kết quả, đổi tên/loại, bỏ vùng không hữu ích và chạy lại với preset khác là thao tác sau quét.

Đầu vào chủ yếu là shot review anime có chữ, nhân vật, graphic. Không cam kết tìm toàn bộ element, nhận tên nhân vật, khôi phục layer gốc, font, phần bị che hay transparency chính xác của tóc/glow. Không thêm inpainting ở bản đầu. Vùng chưa có bằng chứng phân loại mang nhãn `region`, không giả thành `character`.

Ràng buộc phần cứng theo báo cáo 23/10: i5-1035G1, khoảng 12 GB RAM, Intel UHD, không có NVIDIA CUDA. RAM trống 3,25 GiB là số đo cũ, không phải điều kiện hiện tại. Chưa có benchmark model trên máy; mọi preset dưới đây là giá trị khởi đầu để đo.

## Các hướng đã xem xét và quyết định đề xuất

1. Xử lý ảnh truyền thống: nhẹ, không model; không đủ để nhận diện/tách nhân vật trên nền anime phức tạp. Dùng cho hậu xử lý, không làm engine chính.
2. MobileSAM quét mask tự động + RapidOCR detection CPU: không cần cloud, có thể giới hạn workload; cần lọc vùng trùng, vùng bộ phận và vùng nền. Đây là hướng đề xuất theo yêu cầu người dùng giao lựa chọn thư viện.
3. Model hiểu ảnh lớn + segmentation: có ngữ nghĩa tốt hơn nhưng tăng tải RAM/runtime và số dependency; chưa chọn cho cấu hình hiện tại.

Không dùng MobileSAMv2 mặc định vì thêm đường object discovery/dependency; dùng API automatic mask generation của MobileSAM gốc. Pin revision và kiểm tra contract thực tế trước khi chọn lock cuối cùng. Không dùng số đo GPU upstream làm latency CPU của dự án.

## Luồng xử lý

`UPLOAD → VALIDATE → PREPROCESS → DETECT_TEXT → GENERATE_MASKS → FILTER → EXPORT → DONE/PARTIAL/FAILED`

1. Validate định dạng qua decoder, kích thước file và pixel; chỉ ảnh tĩnh, từ chối ảnh động/multipage ở bản đầu. Normalize EXIF orientation, chuyển sRGB; giữ alpha đầu vào. Ảnh quá lớn bị từ chối rõ ràng trước khi decode đầy đủ khi có thể.
2. Lưu ảnh gốc đã normalize và ảnh proxy riêng. Proxy ban đầu cạnh dài tối đa 1024; OCR detector có giới hạn riêng để thử trên chữ nhỏ. Ghi transform giữa proxy và ảnh gốc, tránh bbox/mask sai tỷ lệ.
3. RapidOCR với ONNX Runtime CPU tìm polygon vùng chữ; mặc định chỉ detection, không recognition, giảm phụ thuộc ngôn ngữ. OCR detection không phải alpha mask của chữ. Crop polygon có padding được xuất là `text-region`, `outputKind: crop`, `needsReview: true` vì có thể còn nền. Không quảng cáo crop này là chữ đã tách sạch. Recognition là tùy chọn sau, không bắt buộc bản đầu.
4. MobileSAM chạy automatic mask generation, không cần prompt từ người dùng. Chia grid điểm theo batch nhỏ, không multi-crop mặc định; một embedding cho mỗi ảnh/preset. Xuất từng mask và metadata sớm, tránh giữ toàn bộ mask full-resolution trong RAM. Đánh giá API upstream có tích lũy mask nội bộ; nếu vượt tài nguyên, dùng vòng lặp grid qua predictor và lọc theo batch thay cho generator nguyên khối.
5. Lọc mask rỗng, nhỏ/nhiễu, gần toàn ảnh; xếp theo predicted IoU/stability và diện tích. So mask IoU/containment để loại trùng gần tuyệt đối; không xóa mọi vùng nằm trong vùng khác vì graphic/chữ có thể là element riêng. Giữ quan hệ parent/child khi có. OCR và segmentation không xóa lẫn nhau chỉ vì bbox overlap.
6. Áp mask lên pixel ảnh gốc theo transform, tôn trọng alpha có sẵn; crop sát bbox, tạo PNG RGBA và thumbnail. Nội suy mask không được gọi là khôi phục chi tiết. Thông tin cảnh báo biên từ proxy phải được lưu. Không tạo pixel bị che hoặc dùng rectangle alpha để giả mask segmentation.
7. Ghi manifest nguyên tử sau mỗi giai đoạn/kết quả đủ hợp lệ. ZIP được stream theo yêu cầu, không giữ buffer pack trong RAM. Không tự include ảnh nguồn trong ZIP; pack gồm asset, mask và manifest.

Nếu OCR hỏng, vẫn thử segmentation; nếu segmentation hỏng, giữ các text-region crop nhưng job là PARTIAL và UI chỉ rõ. Nếu không có engine khả dụng, FAILED kèm hướng dẫn setup, không fallback giả thành thành công. Quét không có vùng hợp lệ là DONE với empty state rõ ràng, không xuất cả ảnh làm element dự phòng.

## Resource và cache

- Một job xử lý CPU hoạt động, tối đa hai job chờ; batch image upload chưa thuộc bản đầu.
- Preset Nhanh: proxy 768, grid 8×8, batch 8. Cân bằng: proxy 1024, grid 12×12, batch 8. Đây là cấu hình thử, không cam kết đủ recall.
- MobileSAM có preprocessing theo kích thước encoder cố định; giảm proxy không được mặc nhiên coi là giảm chi phí encoder. Grid/batch/crop/output resolution là các biến cần đo riêng; proxy nhỏ chủ yếu giảm một phần hậu xử lý/bộ nhớ và có thể làm mất chi tiết.
- Trần khởi đầu: 20 MB/file, 24 megapixel, 80 asset, 180 giây/giai đoạn model, 512 MB artifact/job. Nếu chạm trần, ghi `truncated`/PARTIAL và lý do, không âm thầm khẳng định quét đủ.
- Giới hạn luồng CPU (khởi đầu 2); tránh OCR và torch cùng giữ model hoạt động nếu gây áp lực RAM. Nạp các model tuần tự; cân nhắc cache warm có thời hạn sau benchmark, mặc định process theo tác vụ để giải phóng tài nguyên rõ ràng.
- Cache theo hash ảnh đã normalize + model revision/checksum + preset + phiên bản hậu xử lý. Thay engine hoặc ngưỡng làm invalidation. Cache hit không chạy inference lại.
- Timeout/cancel kết thúc process worker thuộc job, giải phóng queue; không kill process ngoài ứng dụng. Dọn upload thất bại, artifact dở và cache theo retention riêng. Người dùng có thể hủy job đang chạy hoặc đang chờ.
- Đo cold load, inference, export, peak working set và kích thước output riêng. Không ghi FPS/thời gian mục tiêu như số đo thực.

## Engine và dependency

- Node/Express/Sharp/archiver đã có: giữ để phục vụ UI/API, normalize/export ảnh và stream ZIP.
- Python 3.10 venv riêng trong workspace; torch CPU, torchvision tương thích, MobileSAM pin revision, timm và OpenCV theo yêu cầu upstream đã kiểm chứng.
- RapidOCR + ONNX Runtime CPU, detection model nhẹ; pin package và model/checksum sau phép thử tương thích. Detector mặc định không được hiểu là nhận dạng chính xác mọi ngôn ngữ.
- Script setup/doctor riêng kiểm tra Python, packages, model paths/checksum. Tải model chỉ ở setup có log nguồn; inference không tự truy cập mạng, không cần key. Lưu model trong `models/`, không dùng thư mục cache toàn hệ thống làm dependency ngầm.
- Tích hợp bằng adapter hẹp và package/revision lock, không chép toàn repo vào app. Ghi provenance/license của code và weights trong `THIRD_PARTY_NOTICES.md` khi triển khai.

Nguồn tham khảo: https://github.com/ChaoningZhang/MobileSAM ; https://github.com/RapidAI/RapidOCR ; https://rapidai.github.io/RapidOCRDocs/v2.1.0/install_usage/rapidocr/usage/ .

## Cấu trúc và chuyển đổi

Entry mới `src/server.js` chỉ khởi động app ảnh và dịch vụ vòng đời. Tách module theo trách nhiệm:

```text
src/app.js                  # tạo Express app, không side effect listen
src/config/                 # config riêng ảnh, validate tập trung
src/features/images/        # upload, validate/normalize, routes
src/features/jobs/          # queue, persistence, lifecycle, events
src/features/elements/      # pipeline, lọc mask, export, manifest
src/integrations/python/    # spawn worker, protocol, timeout/cancel
src/shared/                 # media ID/path validation, errors, logging
src/web/                    # HTML, CSS tokens, JS modules
workers/                    # Python inference adapter và hậu xử lý
scripts/                    # setup models, doctor, benchmark
models/                     # weights local, bỏ qua version control
legacy/video/               # code/tài liệu/test cần cho app video cũ
test/image/                 # API, pipeline, worker contract, regression
```

Các module hiện có chỉ di chuyển khi đã kiểm tra import và test; không gom code cũ dưới namespace mới rồi gọi đó là refactor. Snapshot source/config/public/test video và lệnh `start:legacy` trước khi đổi entry để có đường chạy lại. Không xóa `data/jobs.db`, `.env`, source video hay output cũ. Job ảnh dùng DB/artifact namespace riêng, không ép schema ảnh vào scene v2. App mới không import config video, không kiểm tra FFmpeg/yt-dlp và không yêu cầu ANTHROPIC_API_KEY.

Backend bind 127.0.0.1 mặc định. Worker giao tiếp JSON Lines qua stdin/stdout với request/job ID; logs qua stderr, giới hạn kích thước message. Không interpolate shell command; spawn argv riêng. File/media API dùng ID allowlist và kiểm tra path containment, không nhận filesystem path từ trình duyệt. Đọc SQLite có phân trang, không load mọi job khi render.

## Hợp đồng dữ liệu và API

Job có id, source metadata/hash, preset, status/stage/progress, warnings/failures, timings, engine versions, elements. Element có id, type (`region`/`text-region`/loại do người dùng đặt), bbox/polygon ở ảnh normalized gốc, mask/crop metadata, score thành phần, `needsReview`, outputKind, quan hệ vùng, file ID. Không gộp score model thành cam kết usable.

- `GET /api/config` và `/api/engine/status`: giới hạn upload, preset và engine readiness.
- `POST /api/images`: upload một ảnh, tạo job.
- `GET /api/jobs` và `/api/jobs/:id`: lịch sử phân trang và tiến độ/result.
- `POST /api/jobs/:id/cancel`: hủy job.
- `POST /api/jobs/:id/retry`: quét lại bằng preset được validate; dùng cache khi đúng khóa.
- `PATCH /api/jobs/:id/elements/:elementId`: đổi nhãn/type, đánh dấu chọn/bỏ; validate schema.
- `GET /api/jobs/:id/media/:fileId`: xem ảnh/asset qua ID.
- `POST /api/jobs/:id/export`: gửi danh sách element ID để stream ZIP; export toàn bộ bằng danh sách mặc định, validate mọi ID thuộc job.

## Giao diện đề xuất

Workspace tiếng Việt, tập trung vào upload và kết quả; bỏ YouTube, scene timeline và ô key khỏi app ảnh. Header nhỏ với tên công cụ và trạng thái engine; vùng nguồn bên trái, gallery element bên phải trên desktop, xếp dọc trên màn hình hẹp. Đây là phương án thiết kế của người triển khai, chưa phải lựa chọn đã được người dùng duyệt.

- Upload drag/drop có nút file chuẩn, preset, nút Quét tự động; hiển thị giới hạn trước khi gửi.
- Ảnh nguồn có overlay vùng tìm thấy và toggle overlay; click kết quả làm nổi vùng tương ứng. Không có bước khoanh vùng bắt buộc.
- Gallery thumbnail nền caro, nhãn crop/mask, trạng thái cần kiểm tra, checkbox tải, xem lớn và đổi tên. Không lặp lại nhãn character không có bằng chứng.
- Phân biệt chưa upload, engine thiếu model, queued, đang xử lý, canceled, empty, PARTIAL và FAILED; giữ kết quả hợp lệ khi một engine hỏng. Tiến độ theo giai đoạn, không giả % thời gian inference.
- Nút tải chỉ bật khi có file thật. Nhãn crop vùng chữ nói rõ có thể còn nền. Có cảnh báo nhỏ tại vùng thiếu pixel, không đưa thuật ngữ backend vào luồng chính.
- CSS variables, màu trung tính tối để xem ảnh và một màu nhấn; system fonts để offline. Focus rõ, label/alt, keyboard navigation, live status không spam, reduced motion, target 44px, không overflow ở 375/768/1440px.
- Dùng JS modules theo upload/job/gallery/preview; thumbnail lazy load, revoke object URL, không nhúng base64 asset vào response JSON. Poll có backoff và dừng khi terminal/tab hidden, phục hồi đúng khi tab hiện.

Tra cứu UI/UX Pro Max cho editor trả thêm pattern landing page không phù hợp; chỉ dùng quy tắc accessibility/performance có liên quan, bỏ pattern hero/CTA. Truy vấn product riêng ban đầu không có kết quả; lần thử lại `developer tool` trả Developer Tool/IDE và Productivity Tool. Chỉ dùng hướng tối giản, focus rõ và phân cấp chức năng phù hợp; bố cục workspace là đề xuất trực tiếp dựa trên tác vụ.

## Kiểm chứng và tiêu chí hoàn thành

1. Test có ý nghĩa cho decode/giới hạn, EXIF coordinate mapping, alpha gốc, dedupe không xóa sai vùng lồng, cache invalidation, cancel/timeout/queue, media traversal, ZIP ID scoping và restart recovery.
2. Worker contract test với fixture deterministic cộng smoke inference thực; mock thành công không đủ để tuyên bố AI local hoạt động.
3. Setup trên venv workspace và chạy inference CPU thật ít nhất một ảnh trước khi báo engine sẵn sàng. Nếu không thể tải/cài vì môi trường, báo phần tích hợp chưa được kiểm chứng, không đổi sang heuristic rồi tuyên bố hoàn tất.
4. Benchmark preset trên ảnh thực sẵn có trong workspace; ghi rõ ảnh fixture hay shot anime thật. Nếu chưa có shot đại diện, báo thiếu kiểm chứng chất lượng anime và cần ảnh mẫu từ người dùng, không tạo số đo thay thế.
5. Browser kiểm tra upload → quét → overlay/gallery → chọn → tải và empty/error/cancel; xem desktop/mobile, console/network errors, keyboard.
6. Suite app ảnh, config/doctor, test tương thích legacy sau di chuyển; kiểm tra cold start không key, không FFmpeg và không network inference.

Hoàn thành kỹ thuật không đồng nghĩa tách toàn bộ element chính xác. Báo cáo cuối phải ghi rõ engine/model thực đã dùng, kết quả benchmark, phần crop vùng chữ còn nền và trường hợp chưa xử lý tốt.

## Quyết định còn để implementation

Version lock cuối sau kiểm tra tương thích; ngưỡng mask IoU/stability/area, số luồng và preset có thể giảm theo benchmark. Không thêm cloud, model lớn hoặc dependency mới ngoài phạm vi này chỉ để che hạn chế chất lượng. Nếu MobileSAM không chạy vừa tài nguyên, báo benchmark và giữ lỗi engine rõ ràng trước khi đề xuất đổi engine.

## Kiểm tra thiết kế

Reviewer độc lập đã đọc thiết kế và không tìm thấy câu hỏi quan trọng còn thiếu trước khi lập kế hoạch triển khai. Kết luận này chỉ kiểm tra độ đầy đủ của thiết kế, không xác nhận chất lượng hay tốc độ inference.
