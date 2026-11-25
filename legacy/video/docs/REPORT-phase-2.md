# Báo cáo Phase 2 — Candidate Detection (Cheap CV)

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất tasks 2.1–2.8: dHash, Hamming, sharpness variance-of-Laplacian, ffmpeg sampling, freezedetect, scene fallback, grouping/representative selection, debug API và tuning harness. Phase này không gọi Vision/API ngoài.

## Thay đổi

- Implement `src/utils/hash.js`: dHash 64-bit lowercase hex, Hamming validation, và chroma signature làm tie-breaker cho ảnh màu phẳng.
- Implement `src/utils/sharpness.js`: Laplacian variance trên ảnh grayscale được normalize kích thước.
- Tạo `src/services/candidateService.js` với sampling, freeze/scene detection, fallback, anti-drift grouping, sharpest representative, cap và idempotent output.
- Thêm `parseSceneCuts()` vào ffmpeg helpers.
- Thay stage hậu-ingestion bằng candidate detection cho cả upload và URL branch.
- Thêm `/candidates` static và `GET /api/jobs/:id/candidates`; job response chỉ trả public candidate URLs, không leak filesystem path.
- Gate legacy frame endpoints bằng `?legacy=1` và ngừng mount `/frames` public.
- Tạo fixture generator, tuning harness và [bảng tuning](./PLAN-phase-2-tuning.md).
- Thêm test suite Phase 2 vào `test/phase2.test.js`.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P2-01 | Grayscale dHash của các slide màu phẳng đều gần như giống nhau; slideshow 8 slide bị gộp còn 1. | Giữ dHash theo contract, thêm chroma signature normalize brightness làm tie-breaker khi hamming gần threshold. | Đã sửa |
| P2-02 | Gán timestamp vào freeze span với end inclusive nhận frame motion tại biên cuối, tạo candidate thứ 9. | Dùng khoảng cuối mở (`timestamp < end`). | Đã sửa |
| P2-03 | Serializer candidate URL thêm job ID hai lần, trả 404. | Kiểm tra path component đầu là job ID và build URL từ relative path đúng một lần. | Đã sửa |
| P2-04 | Clip không có scene cut vượt threshold (Ken Burns) có thể trả 0 dù fallback bật. | Fallback seed sample đầu để tạo review candidate; tắt fallback vẫn trả 0 như contract. | Đã sửa |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `node scripts/make-fixtures.js` | PASS — tạo đủ image/slideshow/Ken Burns fixtures |
| `npm.cmd test` | PASS — 14 tests, 14 passed, 0 failed |
| dHash brightness shift | PASS — Hamming 2 |
| dHash resize | PASS — Hamming 0 |
| dHash ảnh unrelated | PASS — Hamming 54 với fixture bars/red (>=20) |
| Sharpness sharp/blur/flat | PASS — 471.96 / 7.88 / 0 |
| Sampling 1fps/2fps | PASS — 5/10 frames, timestamp đúng |
| Freezedetect slideshow/motion/strict duration | PASS — 8/0/0 spans |
| Anti-drift grouping | PASS — 2 groups thay vì chaining thành 1 |
| Slideshow candidate detection | PASS — đúng 8 candidates tại 6,10,14,18,22,26,30,34 giây |
| Idempotent rerun | PASS — không tích lũy file cũ, 43 sample frames |
| Scene fallback bật/tắt | PASS — Ken Burns 1 candidate + `scene_fallback`; tắt trả 0 |
| Tuning harness | PASS — cả 4 cấu hình đều 8/8, missed 0 |
| HTTP upload pipeline | PASS — `202 uploading` → `done`, 8 candidates |
| Candidate debug API/static image | PASS — API 200, ảnh candidate 200 |
| Legacy frames endpoint không có `legacy=1` | PASS — HTTP 410 rõ ràng |
| Job JSON leak absolute path | PASS — không có filesystem path |

## Trạng thái cuối phase

Phase 2 hoàn tất. Pipeline đã chuyển từ tách toàn bộ frame sang tạo candidate; `job.candidates` được lưu metadata và có thể kiểm tra qua debug API trước khi bật Vision ở Phase 3.
