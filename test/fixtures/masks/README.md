# Ground truth cho mask

Cách tạo GT cho một ảnh:

1. Chạy quét ảnh trong Anime Element Studio.
2. Sửa mask từng đối tượng trong **Chỉnh layer** cho đến khi khớp ý bạn.
3. Tải ZIP, rồi chép các file `*.mask.png` vào `test/fixtures/masks/<tên-ảnh>/` và ghi `gt.json` cùng thư mục.

`gt.json`:

```json
{"image": [1920, 1080], "objects": [{"name": "char_a", "mask": "char_a.png", "bbox": [x, y, w, h]}]}
```

- `image`: `[rộng, cao]` ảnh nguồn (pixel).
- `mask`: PNG alpha 8-bit, kích thước đúng bằng bbox.
- `bbox`: `[trái, trên, rộng, cao]` trong tọa độ ảnh nguồn.

Đo: `python scripts/evaluate-masks.py <thư-mục-elements> test/fixtures/masks/<tên-ảnh> --json out.json`
(thư mục elements chứa `result.json`; bỏ qua các element `text-region`).
