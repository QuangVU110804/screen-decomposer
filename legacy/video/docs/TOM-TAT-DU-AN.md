# Tóm tắt cách hoạt động của Video Scene Decomposer

## Mục đích

Dự án là ứng dụng web giúp editor lấy các thành phần hình ảnh có thể tái sử dụng từ video: người, nhân vật, screenshot, ảnh, chữ và graphic. Theo [tài liệu định hướng](../video_scene_decomposer_project_reframing.md), mô hình chính là **Video → Scene → Element → Asset pack**, thay cho việc chỉ tìm và lưu frame đẹp hoặc đứng yên.

## Luồng xử lý hiện tại

1. **Nhận video:** người dùng dán URL/ID YouTube hoặc upload file. Server dùng yt-dlp để tải, Multer nhận upload và ffprobe kiểm tra video, thời lượng, độ phân giải.
2. **Tạo job và xếp hàng:** trạng thái được lưu trong SQLite; mỗi lần chỉ chạy một pipeline nặng, tối đa 5 job chờ. Giao diện hỏi tiến độ định kỳ khoảng 1,5 giây.
3. **Chia scene:** FFmpeg tìm điểm cắt, fade/khoảng đen, thay đổi bố cục và đột biến chuyển động. Các scene phủ toàn bộ video, không có khoảng hở hay chồng lấn; đoạn quá dài được chia nhỏ.
4. **Chọn keyframe:** lấy mẫu ảnh đại diện, đánh giá độ nét, độ khác biệt và chuyển đổi; sau đó trích lại ảnh đã chọn ở độ phân giải nguồn. Mặc định nhắm 5 keyframe/scene, điều chỉnh theo độ dài và ngân sách; mỗi scene luôn có ít nhất một keyframe.
5. **Hiểu scene bằng Claude Vision:** gửi các keyframe của cùng scene trong một yêu cầu để nhận loại element, mô tả, vị trí, mức che khuất và khả năng trích xuất. Cùng một element có thể có nhiều lần quan sát qua các keyframe.
6. **Liên kết và trích xuất:** ghép element thành track bằng mô tả, vị trí và độ gần theo scene; chọn lần quan sát phù hợp nhất để crop, tách nền hoặc phục hồi nền.
7. **Kiểm tra và gộp trùng:** chấm chất lượng theo độ nét, kích thước, độ hiển thị, mask và nguồn gốc pixel; kiểm tra file/alpha; kết hợp hash ảnh, màu sắc, mask và ngữ nghĩa để gộp asset lặp lại.
8. **Đóng gói và tải:** giao diện hiển thị timeline, keyframe và gallery có bộ lọc. Người dùng tải từng asset, ZIP một scene hoặc ZIP toàn bộ video; có thể gửi đánh giá hữu ích. API hỗ trợ phân tích lại một scene và dựng lại pack.

## Các loại kết quả

| Nhãn | Ý nghĩa |
|---|---|
| `DIRECT` | Crop hoặc hiệu chỉnh vùng ảnh từ pixel nguồn. |
| `SEGMENTED` | Tách pixel nguồn bằng mask, xuất PNG có nền trong suốt. |
| `RECONSTRUCTED` | Phục hồi nền bằng keyframe khác hoặc inpainting; ghi rõ vùng phục hồi và tỷ lệ pixel tạo lại. |
| `FAILED` | Không trích xuất/kiểm tra được; giữ thông tin chẩn đoán, ẩn khỏi gallery mặc định. |

Quality có ba mức `usable`, `review`, `failed` và không đồng nghĩa độ tự tin của AI. Job kết thúc bằng `done`, `partial` hoặc `failed`; lỗi ở một scene/asset có thể giữ lại kết quả của phần còn lại.

## Kiến trúc và dữ liệu

- **Giao diện:** HTML/CSS/JavaScript thuần trong `src/public/`.
- **Backend:** Node.js ≥ 22.13, Express; API tạo job ở `/api/extract`, API scene/asset ở `/api/v2/`.
- **Điều phối:** `src/pipeline/pipelineService.js`; từng bước xử lý nằm trong `src/services/`; schema Scene/Element/Track/Asset nằm trong `src/domain/`.
- **Lưu trữ:** lịch sử và trạng thái trong `data/jobs.db`; source, keyframe và cache trong `temp/jobs/<jobId>/`; pack trong `temp/assets/<jobId>/` gồm `manifest.json` và các thư mục `scene_001/`, `scene_002/`… chứa preview, keyframe, asset và metadata.
- **Vòng đời:** dữ liệu tạm được dọn theo retention, mặc định 24 giờ và quét mỗi giờ; lịch sử SQLite có thể còn sau khi file bị dọn. Server khởi động lại sẽ đánh dấu job đang dở là lỗi, không tự tiếp tục pipeline.

## Giới hạn cần hiểu

- Video đã render mất thông tin layer gốc; dự án không cam kết khôi phục chính xác project dựng hay pixel bị che.
- Claude làm nhiệm vụ hiểu hình ảnh; FFmpeg/Sharp xử lý media tại máy. Segmentation/inpainting có adapter HTTP riêng và fallback local đơn giản dành cho phát triển, chưa bảo đảm chất lượng với tóc, hiệu ứng hay nền phức tạp.
- Phục hồi nền mặc định **tắt**. OCR mặc định dùng nội dung chữ do scene analyzer trả về; liên kết track hiện dùng heuristic, chưa phải theo dõi đối tượng trên mọi frame.
- Có giới hạn thời lượng, dung lượng, số scene/keyframe, payload AI, số lượt segmentation, vùng inpaint, disk và runtime. Mặc định video tối đa 10 phút, upload tối đa 500 MB.
- Code legacy vẫn phục vụ tương thích kết quả trích frame cũ; job mới đi qua pipeline scene v2.
- Tìm nguồn ảnh gốc/reverse image search chưa được triển khai. Báo cáo kiểm thử synthetic không thay thế đánh giá chất lượng bằng provider thực và editor.

Đọc chi tiết: [README](../README.md), [hướng dẫn hoạt động](HUONG-DAN-HOAT-DONG.md), [ranh giới provider](adr/0002-provider-boundaries.md).
