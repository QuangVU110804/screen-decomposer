# Phase 2 Candidate Tuning

Ngày đo: 2026-08-31

## Fixture

`node scripts/make-fixtures.js` tạo `slideshow.mp4` dài 43 giây gồm 6 giây motion intro, tám slide màu giữ 4 giây, và 5 giây motion outro. Expected candidate timestamps: `6, 10, 14, 18, 22, 26, 30, 34`.

## Kết quả đo

| video | fps | freeze_d | hamming | candidates | expected | missed | dupes* | time_ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| slideshow.mp4 | 1 | 0.8 | 10 | 8 | 8 | 0 | 28 | 1656 |
| slideshow.mp4 | 1 | 0.8 | 20 | 8 | 8 | 0 | 28 | 2031 |
| slideshow.mp4 | 1 | 3.0 | 10 | 8 | 8 | 0 | 28 | 2413 |
| slideshow.mp4 | 1 | 3.0 | 20 | 8 | 8 | 0 | 28 | 2250 |

`dupes` trong harness được định nghĩa thuần theo dHash giữa các candidate. Vì fixture dùng tám màu phẳng, grayscale dHash của các màu có thể giống nhau nên chỉ số này báo 28 cặp dù pipeline đã dùng chroma tie-breaker và thực tế trả đúng tám group khác nhau. Đây là lý do giữ dHash theo contract nhưng bổ sung chroma khi dHash trùng.

## Giá trị chọn

- `SAMPLE_FPS=1`: đủ chính xác cho các still window dài; giảm đáng kể số ảnh cần xử lý.
- `MIN_ASSET_STILL_SEC=0.8`: bắt được slide ngắn hơn fixture mà không coi một frame đơn lẻ là asset.
- `PHASH_HAMMING_THRESHOLD=10`: giữ các frame cùng slide trong một group; các bài brightness/resize có khoảng cách 0–2.
- `MAX_CANDIDATES=60`: giới hạn chi phí Vision về sau; cao hơn nhiều so với 8 candidate của fixture.
- `FREEZE_NOISE_DB=-50dB`: ít strict hơn mặc định `-60dB`, phù hợp still có watermark/caption nhẹ.

## Điều chỉnh sau kiểm thử

- Dùng khoảng cuối mở (`timestamp < freeze_end`) khi gán sample vào freeze span; nếu dùng inclusive boundary, frame đầu motion outro ở giây 38 bị nhận nhầm thành candidate thứ 9.
- Khi dHash trùng, so chroma trung bình đã chuẩn hóa để các slide màu phẳng không bị gộp.
- Fallback scene-cut có seed frame đầu khi clip không phát hiện được cut nào; giúp clip Ken Burns vẫn có candidate để Vision đánh giá. Khi `FALLBACK_TO_SCENE_CUTS=false`, không có candidate fallback.
