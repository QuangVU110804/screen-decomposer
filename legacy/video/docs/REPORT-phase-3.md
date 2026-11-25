# Báo cáo Phase 3 — Claude Vision (Confirm + Label)

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất tasks 3.1–3.6: cài Anthropic SDK, chuẩn bị ảnh JPEG, prompt, forced `report_assets` tool call, validate response, retry/backoff, batch orchestration, progress mapping và pipeline wiring. Không tự gọi API trả phí khi local key đang trống.

## Thay đổi

- Cài `@anthropic-ai/sdk@0.122.0`.
- Tạo `src/services/visionService.js`:
  - resize JPEG bounded bởi `VISION_MAX_EDGE_PX`/`VISION_JPEG_QUALITY`;
  - system prompt conservative cho inserted visual assets;
  - schema `report_assets` và `tool_choice: { type: 'tool', name: 'report_assets' }`;
  - validate ref, loại duplicate/out-of-range, clamp confidence;
  - prepare toàn bộ ảnh một lần trước khi batch;
  - retry 429/5xx/network/timeout; batch lỗi được bỏ qua, kết quả khác vẫn giữ.
- Nối Vision vào stage chung cho cả upload và URL pipeline; progress Vision 35–90%, lưu `job.assets`, log số API call.
- Job failed do thiếu key vẫn giữ `candidateCount` và candidates để chẩn đoán.
- API serialization chuyển `assets[].framePath` sang public candidate URL, không trả absolute path.
- Thêm test mock client cho tool schema, malformed refs, retry, partial failure và reuse base64.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P3-01 | SDK cài trong sandbox bị `EACCES` khi truy cập registry. | Retry npm với quyền network cần thiết; cài thành công. | Đã xử lý |
| P3-02 | Job thiếu API key fail trước khi ghi số candidate đã phát hiện. | Ghi `candidateCount` ngay sau candidate stage, trước guard key. | Đã sửa |
| P3-03 | Mock/Claude có thể trả ref thiếu, sai kiểu, ngoài batch hoặc trùng. | `validateVerdicts()` lọc an toàn; frame thiếu được coi là non-asset, không crash batch. | Đã sửa |
| P3-04 | Retry có thể re-encode/read lại ảnh và tăng chi phí/latency. | Prepare bằng `Promise.all` một lần; retry gửi lại `_b64` đã cache. | Đã sửa |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `require('@anthropic-ai/sdk')` | PASS — SDK load được, `client.messages.create` tồn tại |
| `npm.cmd test` | PASS — 20 tests, 20 passed, 0 failed |
| JPEG prep + không enlarge ảnh 640x480 | PASS |
| Forced tool schema/temperature 0 | PASS bằng mock — đúng `tools`, `tool_choice`, `temperature` |
| Batch 7 candidates với batch size 5 | PASS — 2 API calls mock, progress 0.5 → 1 |
| 429 batch retry | PASS — retry thành công, tổng 3 calls, base64 retry giống nhau |
| Permanent batch failure | PASS — batch lỗi bị skip, kết quả các batch khác giữ nguyên |
| Malformed/missing/duplicate ref | PASS — không throw, chỉ nhận ref hợp lệ |
| Pipeline thiếu `ANTHROPIC_API_KEY` | PASS — `uploading` → `failed`, error actionable, `candidateCount: 8`, server health vẫn OK |
| Kiểm tra không có API call thật | PASS — `.env` không có key, tất cả Vision test dùng mock |

## Acceptance chưa thể xác minh trực tiếp

Task 3.7 yêu cầu chạy video thật với Anthropic key và đối chiếu precision/recall. Key hiện đang trống nên chưa thực hiện live Vision call và không phát sinh chi phí. Code path đã được kiểm thử đầy đủ bằng mock tương ứng; cần chạy lại manual validation sau khi cấu hình key hợp lệ.

## Trạng thái cuối phase

Các task code của Phase 3 hoàn tất. Pipeline đã sẵn sàng phân loại Vision; bước xác nhận chất lượng trên video thật còn phụ thuộc credential bên ngoài chưa có trong môi trường.
