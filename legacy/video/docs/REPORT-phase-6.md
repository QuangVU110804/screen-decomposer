# Phase 6 — Báo cáo triển khai Web UI

Ngày thực hiện: 2026-08-31

## Kết quả

Đã thay thế placeholder bằng giao diện HTML/CSS/JS thuần tại `src/public/`.

- `index.html`: hai tab YouTube URL và Upload file, progress, kết quả, lỗi/retry.
- `app.js`: đọc `/api/config`, submit URL/upload, drag-and-drop, kiểm tra size phía client, polling 1.5 giây, retry khi mất kết nối 3 giây, resume qua `localStorage.lastJobId`.
- `style.css`: dark theme responsive, progress transition, dropzone dragging state và asset grid `auto-fill/minmax(220px, 1fr)`.
- Asset card có thumbnail, nhãn, timecode, mô tả, link ảnh đầy đủ, tải từng ảnh và tải ZIP.

Nội dung từ Vision/LLM được đưa vào DOM bằng `textContent` và node API; không dùng `innerHTML`, `eval` hay inline event handler. Vì vậy nhãn/mô tả chứa HTML hoặc dấu quote vẫn hiển thị như text.

## Bug phát hiện và xử lý

### P6-01 — Poll cũ có thể giành timer của job mới

Trong lúc request poll cũ còn đang chờ, người dùng có thể bắt đầu job mới. Nếu response cũ về sau đó, nó có thể đặt lại timer cho job cũ.

Đã xử lý bằng cách hủy timer, reset `activeJobId` khi bắt đầu request mới và kiểm tra `activeJobId` sau `fetch`/khi retry trước khi render hoặc schedule poll tiếp.

## Kiểm thử

- `node --check src/public/app.js`: đạt.
- `node --check src/server.js`: đạt.
- `npm.cmd test`: **32/32 pass**.
- Smoke HTTP với server local port 3316:
  - `/`: 200
  - `/app.js`: 200
  - `/style.css`: 200
  - `/api/config`: 200, trả đúng giới hạn upload/thời lượng/extension
  - `/api/jobs`: 200
- Runtime UI harness kiểm tra tab switching, empty URL không gọi network, render asset chứa `<script>`/quote như text, terminal polling và retry.

## Walkthrough 6.8

Đã kiểm tra được phần server/static và các nhánh UI bằng runtime harness. In-app Browser của môi trường hiện không có backend `iab`, nên không thể hoàn tất walkthrough trực quan 6 bước (resize viewport, native file picker, click mở ảnh và download trong browser thật) trong phiên này. Đây là giới hạn môi trường kiểm thử, không phải lỗi ứng dụng; các endpoint vẫn được phục vụ same-origin và không cần CORS.

Giới hạn đã ghi nhận theo kế hoạch: upload transfer chưa có progress bar riêng; progress bắt đầu sau khi upload hoàn tất.
