# Báo cáo Phase 1 — Ingestion (YouTube URL + File Upload)

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất các task 1.1–1.8 theo [PLAN-phase-1.md](./PLAN-phase-1.md). Hai nguồn đầu vào hội tụ vào cùng stage `runIngested()`, hiện vẫn dùng pipeline legacy tách toàn bộ frame để bảo đảm không làm hỏng hành vi cũ.

## Thay đổi

- Cài `multer` 2.x và thêm `npm test` dùng Node test runner.
- Tạo `src/services/ingestionService.js` với `resolveYoutube()`, `guardDuration()` và `acceptUpload()`.
- Tạo `src/middleware/upload.js`: disk storage vào `temp/uploads`, tên UUID `.part`, giới hạn `fileSize`/`files`.
- Refactor URL route để lưu `sourceType: 'youtube'`, dùng duration guard và stage chung.
- Thêm `POST /api/extract/upload`, xử lý lỗi multipart, cleanup file tạm và trả `202` ngay.
- Thêm static mount cho `src/public` và placeholder `index.html`.
- Thêm unit tests cho normalize URL, upload validation, move file và ffprobe duration.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P1-01 | Test `acceptUpload()` không nạp `.env`, nên dùng `ffprobe` từ PATH thay vì path cấu hình. | Nạp `dotenv` trước khi require config trong test. | Đã sửa |
| P1-02 | Upload lỗi có thể để lại `.part` nếu multer dừng trước khi tạo `req.file` (đặc biệt `LIMIT_FILE_SIZE`). | Middleware lưu `_uploadTempPath` trên request; route cleanup cả path này và service cleanup mọi failure path. | Đã sửa |
| P1-03 | Input URL không phải string có thể gây lỗi `.trim()`/regex không rõ ràng. | `resolveYoutube()` kiểm tra type và trả lỗi URL dễ đọc. | Đã sửa |
| ENV-01 | `npm install multer` lần đầu bị `EACCES` khi sandbox truy cập registry. | Chạy lại đúng lệnh với quyền network cần thiết; cài thành công. | Đã xử lý |
| TEST-01 | `Invoke-WebRequest` trên PowerShell gặp NullReference khi đọc root static response. | Dùng `curl.exe` cho HTTP smoke test; server không có lỗi tương ứng. | Đã xử lý |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `npm.cmd test` với ffprobe/fixture cục bộ | PASS — 6 tests, 6 passed, 0 failed |
| `resolveYoutube()` watch/embed/youtu.be/raw ID | PASS |
| Upload hợp lệ `sample.mp4` qua service | PASS — tạo `temp/videos/{jobId}.mp4`, duration 5 giây |
| File `.txt` giả danh upload | PASS — job/service failed rõ ràng, temp file bị xóa |
| Duration guard với limit 2 giây cho fixture 5 giây | PASS — báo vượt giới hạn |
| Server boot + `GET /health` | PASS — `{"ok":true}` |
| `GET /` placeholder | PASS — HTTP 200, có nội dung “UI in Phase 6” |
| Upload hợp lệ qua HTTP | PASS — `202 uploading` → `done`, `sourceType: upload`, 125 frame |
| Download legacy ZIP | PASS — file ZIP tạo được, 2,378,730 bytes |
| Không có field `file` | PASS — HTTP 400, không tạo job treo |
| Upload sai extension | PASS — `202 uploading` → `failed`, `temp/uploads` còn 0 file |
| Syntax toàn bộ source | PASS |

## Ghi chú acceptance chưa chạy qua mạng ngoài

URL YouTube thật chưa dùng để regression trong phase này vì test phụ thuộc mạng và dịch vụ bên ngoài; nhánh URL đã được refactor, normalize và giữ nguyên `downloadService.js`. Sẽ kiểm tra lại end-to-end khi chạy regression toàn hệ thống nếu môi trường mạng cho phép.

## Trạng thái cuối phase

Phase 1 hoàn tất. Hệ thống hiện có hai front door (YouTube URL và upload file), cùng một stage hậu-ingestion, và sẵn sàng để Phase 2 thay phần tách toàn bộ frame bằng candidate detection.
