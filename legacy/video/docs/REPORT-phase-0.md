# Báo cáo Phase 0 — Foundation, Config & Job Model

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất các task 0.1–0.7 theo [PLAN-phase-0.md](./PLAN-phase-0.md), không thêm logic detection/AI. Luồng legacy tải YouTube → tách toàn bộ frame vẫn được giữ nguyên để dùng làm regression trong các phase sau.

## Thay đổi

- Xác nhận `sharp` đã được cài và `require('sharp')` hoạt động.
- Bổ sung config canonical trong `src/config.js`: thư mục tạm, binary paths, giới hạn upload/video, sampling, freeze/scene fallback, Vision và retention; thêm parse/validation, `ensureDir()` và `assertBinaries()` fail-fast.
- Mở rộng job model với `sourceType`, `originalFilename`, `duration`, `candidates`, `assets`, cùng `getJobOrThrow()`/`listJobs()`; bảo đảm `updatedAt` tăng đơn điệu khi cập nhật.
- Hoàn thiện parser/wrapper ffmpeg và tăng khả năng chấp nhận whitespace/số âm trong timestamp.
- Cập nhật `.env.example` và bổ sung các key Phase 2–3 còn thiếu vào `.env` mà không thay đổi secret hiện có.
- Thêm script `npm test` và bộ test `test/phase0.test.js`.

Các file legacy `src/services/downloadService.js`, `src/services/frameExtractionService.js` và `src/utils/videoInfo.js` không bị sửa.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P0-01 | `updatedAt` có thể trùng timestamp nếu nhiều update xảy ra trong cùng một millisecond. | `jobService.updateJob()` ép timestamp mới lớn hơn timestamp cũ tối thiểu 1 ms. | Đã sửa |
| P0-02 | `parseSceneDetect()` và parser freeze chưa chấp nhận một số dạng whitespace/số âm của ffmpeg. | Nới regex, vẫn giữ format output của contract. | Đã sửa |
| ENV-01 | Sandbox thường không truy cập được đường dẫn WinGet của ffmpeg/ffprobe. | Không đổi logic fail-fast; chạy kiểm thử runtime bằng quyền truy cập cần thiết và ghi nhận đây là vấn đề môi trường. | Đã xác minh |
| ENV-02 | Cổng 3000 đã có tiến trình sử dụng khi kiểm tra boot. | Dùng cổng kiểm thử 3310, không dừng tiến trình ngoài phạm vi. | Đã xử lý trong test |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `npm.cmd test` | PASS — 3 tests, 3 passed, 0 failed |
| `node -e "require('sharp')"` | PASS |
| Kiểm tra type/toàn bộ config + `validateConfig()` | PASS; chỉ warning khi thiếu `ANTHROPIC_API_KEY` |
| `node src/server.js` với `FFMPEG_PATH=nope` | PASS theo acceptance — thoát code 1, báo lỗi rõ ràng trước `app.listen()` |
| `ffmpeg` + `parseFreezeDetect` trên `temp/test-fixtures/red.mp4` | PASS — nhận một freeze span bắt đầu tại 0 giây và kéo tới cuối video |
| `runFfmpeg()` với binary không tồn tại | PASS — Promise reject `ENOENT`, không bị treo |
| Server boot trên cổng 3310 + `GET /health` | PASS — `{"ok":true}` |
| Kiểm tra syntax toàn bộ `src/*.js` | PASS |

## Trạng thái cuối phase

Phase 0 hoàn tất. Nền tảng config/job/utility đã sẵn sàng cho Phase 1. Các tính năng upload, candidate detection, Vision, asset API và UI chưa triển khai theo đúng phạm vi phase.
