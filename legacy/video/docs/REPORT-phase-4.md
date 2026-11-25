# Báo cáo Phase 4 — Asset Extraction & Finalization

Ngày thực hiện: 2026-08-31

## Phạm vi

Hoàn tất tasks 4.1–4.4: tạo asset PNG ổn định, thumbnail JPEG, manifest, numbering theo timestamp, idempotent rerun và failure safety net trong pipeline.

## Thay đổi

- Tạo `src/services/assetExtractionService.js`.
- Finalizer sort assets theo timestamp, copy byte-for-byte candidate PNG sang `asset_001.png`, tạo thumbnail 320px JPEG quality 80 và ghi `manifest.json` chỉ chứa basename.
- Dùng staging directory + rename để output final chỉ xuất hiện sau khi build hoàn tất; staging được cleanup khi lỗi.
- Nối stage `finalizing` (progress 92) vào pipeline; lỗi được bọc bằng `Lỗi khi hoàn tất asset: ...` và outer pipeline chuyển job sang `failed`.
- Cập nhật serialization để final asset paths có thể chuyển sang public `/assets/...` ở Phase 5.
- Thêm test cho sort/copy/thumbnail/manifest, empty assets, shrink rerun và corrupted candidate.

## Bug và cách khắc phục

| Mã | Phát hiện | Khắc phục | Trạng thái |
|---|---|---|---|
| P4-01 | Assertion test ban đầu không khớp message thực tế của sharp (`Input file contains unsupported image format`). | Nới assertion để bao phủ message `Input file`/`Input buffer` mà vẫn kiểm tra failure. | Đã sửa |
| P4-02 | Asset serializer cũ chỉ biết candidate path, nên final path sẽ bị trả null trước khi asset API tồn tại. | Thêm guarded mapping cho `ASSET_DIR` và thumbnail path; Phase 5 sẽ mount route public. | Đã sửa |
| P4-03 | Ghi thẳng vào final directory có thể để lại file nửa chừng nếu disk/sharp lỗi. | Build trong staging, ghi manifest rồi atomic rename; staging bị xóa khi throw. | Đã sửa |

## Kết quả kiểm thử

| Kiểm thử | Kết quả |
|---|---|
| `npm.cmd test` | PASS — 24 tests, 24 passed, 0 failed |
| Sort 4 assets unsorted | PASS — numbering theo timestamp 001–004 |
| PNG byte-identical với candidate | PASS |
| Thumbnail JPEG ≤320px | PASS |
| Manifest JSON + `assetCount` | PASS |
| Rerun 5 assets → shrink còn 4 | PASS — không còn `asset_005` |
| Empty assets | PASS — thư mục + manifest rỗng, không throw |
| Corrupt candidate | PASS — reject rõ ràng, không để final directory |
| Syntax toàn bộ source/script/test | PASS |

## Acceptance phụ thuộc external credential

Full HTTP pipeline với Vision thật chưa thể chạy vì `ANTHROPIC_API_KEY` đang trống. Finalizer đã được kiểm thử độc lập với candidate fixtures và mock Vision ở Phase 3; nhánh thiếu key vẫn fail trước finalization theo thiết kế.

## Trạng thái cuối phase

Phase 4 code hoàn tất. Khi có Vision verdicts hợp lệ, job sẽ kết thúc với asset files ổn định trong `temp/assets/<jobId>/` và manifest tương ứng.
