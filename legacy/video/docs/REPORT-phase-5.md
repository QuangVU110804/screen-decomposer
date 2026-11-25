# Báo cáo Phase 5 — API Endpoints

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất tasks 5.1–5.7: serializer public, guarded asset serving, asset/job APIs, ZIP download, job list/config và loại bỏ legacy all-frames surface.

## Thay đổi

- Tạo `src/utils/serialize.js`; mọi job/asset response bỏ filesystem paths và dùng `/assets/<jobId>/<basename>` URLs.
- Tạo `src/routes/assetRoutes.js` với UUID validation, filename allowlist, `path.resolve` containment guard, asset list, ZIP, job list và config endpoint.
- Mount asset router ở `/`; giữ extract router ở `/api`.
- `GET /api/jobs/:id` hoạt động ở mọi status; assets/download dùng HTTP 409 khi job chưa done.
- `/api/config` chỉ trả `maxUploadMb`, `maxDurationSec`, `allowedExtensions`.
- Xóa legacy `GET /api/jobs/:id/frames`, legacy download và static `/frames`; xóa `FRAME_DIR`/`frameExtractionService.js` vì pipeline asset đã thay thế.
- Giữ `CANDIDATE_DIR` nội bộ cho Phase 2/cleanup, nhưng không expose static candidate path nữa.
- Thêm test HTTP router cho public images, traversal, list/config/status/ZIP.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P5-01 | `serializeJobSummary()` đọc `job.assets` sau khi `listJobs()` đã trả summary object, nên `assetCount` luôn bằng 0. | Ưu tiên `job.assetCount` rồi fallback về `job.assets.length`. | Đã sửa |
| P5-02 | Candidate URL ở Phase 2 từng lặp job ID và trả 404. | Serializer Phase 5 tập trung dùng basename + asset root; test route kiểm tra URL chuẩn. | Đã sửa |
| P5-03 | Raw traversal có nhiều path segment có thể bypass exact route và rơi vào generic 404. | Thêm catch-all `router.use('/assets', ...)` trả 400 rõ ràng cho request malformed. | Đã sửa |
| P5-04 | ZIP stream có thể đã gửi header trước khi xảy ra lỗi; `res.status(500)` không còn tác dụng. | Dùng `res.destroy(err)` sau khi log stream error. | Đã sửa |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `npm.cmd test` | PASS — 27 tests, 27 passed, 0 failed |
| Serializer không leak `temp`, absolute path, `framePath` | PASS |
| PNG/JPEG allowlisted asset serving | PASS — HTTP 200 + content type đúng |
| UUID/filename invalid, manifest trực tiếp, nonexistent asset | PASS — 400/404 đúng |
| Encoded traversal `%2e%2e%2f` | PASS — bị chặn |
| `GET /api/jobs/:id/assets` done/pending/unknown | PASS — 200/409/404 |
| Asset ZIP gồm PNG, thumbnail, manifest ở archive root | PASS |
| Missing asset directory | PASS — 404 JSON |
| `/api/config` | PASS — đúng 3 key, không có secret |
| `/api/jobs` | PASS — summary có `assetCount`, sort newest-first logic |
| Syntax source/script/test | PASS |
| Legacy frame references trong `src` | PASS — không còn route/static/service reference |

## Ghi chú

End-to-end với job có asset thật vẫn phụ thuộc Vision key; router và finalizer đã được kiểm thử bằng fixture/job nội bộ có cấu trúc giống production.

## Trạng thái cuối phase

Phase 5 hoàn tất. API public đã sẵn sàng cho UI Phase 6.
