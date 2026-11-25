# Phase 7 — Báo cáo hardening và cleanup

Ngày thực hiện: 2026-08-31

## Kết quả triển khai

- `src/services/pipelineQueue.js`: single-flight queue, 1 pipeline active, tối đa 5 job chờ,
  cập nhật `queuePosition`, trả lỗi có mã `QUEUE_FULL` để route trả HTTP 429.
- `src/services/cleanupService.js`: sweep lúc boot và mỗi giờ trên videos/candidates/assets/uploads,
  dựa trên mtime, có bảo vệ job active/queued và bắt lỗi riêng từng entry.
- `server.js`: khởi động cleanup scheduler, thêm `unhandledRejection` logger và
  `uncaughtException` logger + exit.
- `extractRoutes.js`: cả URL/upload đều enqueue; queue full trả 429; upload quá dung lượng trả 413;
  xóa source video best-effort ngay sau khi `findCandidates` thành công.
- `visionService.js`: defensive truncation theo `MAX_CANDIDATES` và cost log
  `images_sent/api_calls/confirmed_assets` cho từng job.
- `downloadService.js`: bọc phần xử lý `close` của yt-dlp để lỗi đồng bộ được reject thay vì lọt ra
  `uncaughtException`.
- `README.md`: viết lại theo asset pipeline, API cuối, toàn bộ `.env`, queue/cleanup/cost cap và
  giới hạn thực tế.

## Bug phát hiện và xử lý

### P7-01 — Upload vượt giới hạn sai status code

Multer trước đó trả `400` cho `LIMIT_FILE_SIZE`, trong khi API contract dùng `413 Payload Too Large`.
Đã đổi riêng nhánh này sang `413`; các lỗi upload khác vẫn là `400`.

### P7-02 — Queue cần outer safety net

Task pipeline có thể reject trước khi stage tự cập nhật job. Queue hiện bắt reject ở lớp ngoài, đánh
job `failed` với message đọc được và luôn chuyển sang job kế tiếp trong `finally`.

### P7-03 — yt-dlp close callback có thể throw đồng bộ

`readdirSync` sau khi yt-dlp kết thúc không nằm trong `try/catch`. Đã bọc callback để mọi lỗi trở thành
reject, được route bắt và chuyển job sang `failed`.

### P7-04 — Restart để lại staging file của job chờ

Restart giữa queue làm mất queue in-memory theo thiết kế; các `.part` của job chờ có thể còn tới kỳ
retention tiếp theo. Đây là hậu quả đã được ghi rõ trong README; các file fixture của soak test đã
được xóa đúng mục tiêu sau kiểm tra. Sweep theo mtime là lớp thu hồi lâu dài.

## Kiểm thử tự động

`npm.cmd test`: **39/39 pass**.

Các kiểm tra Phase 7 gồm:

- queue serialize, vị trí 1–5, 429 khi đầy và tiếp tục sau task lỗi;
- sweep xóa entry stale, giữ entry mới và tiếp tục khi một entry bị mô phỏng locked;
- Vision truncation từ 20 xuống 5 ảnh và cost counters đúng;
- pipeline thật với fixture: source video không còn sau candidates, job vẫn `done`;
- 20 upload hỗn hợp valid/invalid, `temp/uploads` không phát sinh orphan mới;
- binary ffmpeg sai tên làm job `failed` trong dưới 5 giây, không treo;
- zero match cho `forEach(async ...)`, không static-mount temp private paths và server có process backstop.

## Soak check 7.7

1. Đã gửi 5 job liên tiếp: 4 upload fixture và 1 URL lỗi local. Cả 5 đạt terminal state; 4 job hợp
   lệ đi qua sampling/filtering rồi dừng ở Vision với lỗi rõ ràng do `ANTHROPIC_API_KEY` đang trống,
   1 URL lỗi thất bại ở download. Không có job treo.
2. Đã backdate output candidate của một job, chạy `sweepOnce()` và xác nhận entry stale bị xóa trong
   khi entry candidate khác vẫn còn; sau đó dọn các fixture soak đã tạo.
3. Đã gửi active job + 4 job chờ, quan sát queuePosition 1–4. Restart server có chủ đích làm job cũ
   trả `404` (Map/queue in-memory bị reset đúng thiết kế), server khởi động lại sạch và `/health`
   trả `200`.
4. README đã được đọc/đối chiếu với `.env.example`; script kiểm tra xác nhận mọi env key đều xuất
   hiện trong README và endpoint table bao phủ toàn bộ API Phase 5.

## Giới hạn còn lại

Không thực hiện được live Claude Vision hoặc full 10-minute browser end-to-end vì `.env` không có
`ANTHROPIC_API_KEY`; các test dùng mock client để không phát sinh chi phí. In-app Browser cũng không
có backend `iab` trong môi trường hiện tại, nên phần visual browser walkthrough đã được thay bằng
HTTP smoke + runtime UI harness và ghi nhận ở report Phase 6.
