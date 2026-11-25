# Video Scene Decomposer hoạt động như thế nào?

Tài liệu này giải thích bằng ngôn ngữ bình thường, không yêu cầu đọc code.

## 1. Công cụ giải quyết việc gì?

Một video đã dựng chỉ còn là các pixel phẳng. Nhân vật, background, screenshot, chữ và graphic từng là các layer riêng nhưng thông tin layer gốc đã mất sau khi render.

Video Scene Decomposer không hứa khôi phục project Premiere/After Effects nguyên bản. Mục tiêu thực tế là:

1. chia video thành các scene liên tục;
2. xem nhiều keyframe trong cùng scene;
3. nhận ra những element mà editor có thể muốn tái sử dụng;
4. crop, tách nền hoặc phục hồi chúng;
5. ghi rõ phần nào là pixel nguồn và phần nào được suy luận/tạo lại.

## 2. Đưa video vào

Bạn có thể:

- dán YouTube URL hoặc video ID;
- kéo-thả/upload file mp4, mov, mkv, webm hoặc avi.

Ứng dụng kiểm tra định dạng, dung lượng, thời lượng và stream video. YouTube input chỉ chấp nhận host YouTube; URL tùy ý không được chuyển cho downloader.

## 3. Các bước xử lý

### Xếp hàng

Ứng dụng xử lý một pipeline nặng tại một thời điểm. Job mới có thể chờ trong queue; queue đầy sẽ trả lỗi rõ ràng.

### Đọc video

ffprobe cung cấp duration, resolution, fps và orientation. Source được đặt trong cây artifact của job và giữ đến lần cleanup, thay vì xóa trước khi các bước downstream hoàn tất.

### Phát hiện scene

FFmpeg cung cấp hard-cut score; khoảng đen/fade là tín hiệu transition. Mọi boundary được quy về một danh sách canonical. Scene đầu bắt đầu ở 0, scene cuối kết thúc đúng duration, không có gap/overlap.

Flash rất ngắn được merge có lý do. Scene quá dài có thể được split để giữ budget phân tích, nhưng không đoạn thời gian nào bị âm thầm bỏ.

### Chọn keyframe

Mỗi scene được sample dày hơn ở proxy resolution. Ứng dụng so sharpness và perceptual difference để chọn các frame đa dạng, rồi trích lại keyframe ở source resolution.

Mỗi keyframe ghi lý do như `scene_start`, `scene_midpoint`, `scene_end` hoặc `composition_change`.

### Hiểu scene bằng AI

Nhiều keyframe của cùng một scene được gửi trong một request có stable reference. AI trả:

- type: person, character, background, image, screenshot, text, graphic…;
- mô tả;
- bbox normalized;
- visibility, occlusion, motion;
- semantic/localization confidence;
- khả năng extraction: direct, segmentable, requires inpainting hoặc not extractable.

Cùng một element xuất hiện ở nhiều keyframe được biểu diễn bằng nhiều observation, không lập tức biến thành nhiều asset.

Nếu một scene lỗi AI, scene khác vẫn được giữ và job có thể hoàn tất ở trạng thái `PARTIAL`.

### Tạo asset

- Image/screenshot/text/graphic hình chữ nhật được crop thành `DIRECT`.
- Person/character/graphic cần tách nền được tạo mask và PNG RGBA `SEGMENTED`.
- Background bị che ưu tiên lấy pixel thật từ keyframe khác; vùng còn thiếu mới dùng inpainting và mang nhãn `RECONSTRUCTED`.
- Attempt không đạt validation trở thành `FAILED` và bị ẩn khỏi gallery mặc định.

### Chấm quality và dedupe

Quality xem xét resolution, sharpness, visibility, occlusion, localization, mask edge và lượng reconstruction. AI confidence chỉ là một thành phần.

Dedupe dùng kết hợp perceptual hash, chroma, mask shape, type và semantic similarity. Khi cùng asset lặp lại, manifest giữ một asset identity với nhiều occurrence theo scene.

Cache segmentation/inpainting nằm ngoài thư mục output asset và có provider version trong cache key. Vì vậy re-analyze có thể xóa/rebuild asset output mà vẫn tái sử dụng provider result hợp lệ.

### Đóng gói

Trước khi publish, hệ thống kiểm tra file integrity, alpha, dimension, mask và provenance. Packager ghi atomically:

```text
manifest.json
scene_001/
  scene_preview.jpg
  keyframes/
  assets/
  metadata.json
```

## 4. Giao diện

Kết quả bắt đầu từ timeline scene. Chọn một scene để xem:

- preview và range;
- keyframe evidence;
- element taxonomy;
- asset thuộc scene;
- mode, quality, resolution và mask;
- nút tải asset, scene pack hoặc toàn bộ video pack.

`DIRECT`, `SEGMENTED`, `RECONSTRUCTED` được hiển thị bằng chữ, không chỉ bằng màu. Kết quả legacy được ghi rõ là `Legacy frame`.

## 5. Trạng thái

Trong lúc chạy, status phản ánh stage hiện tại. Kết thúc có ba trạng thái:

- `DONE`: package hợp lệ, không có failure cục bộ;
- `PARTIAL`: scene/asset hữu ích vẫn tồn tại nhưng có failure hoặc asset không đạt gate;
- `FAILED`: pipeline không thể tạo package hợp lệ.

Server restart đánh dấu job đang chạy dở là failed; job đã hoàn thành vẫn tồn tại trong SQLite và filesystem cho đến retention sweep.

## 6. Bảo mật và dữ liệu

- Write endpoint có rate limit và optional `X-API-Key`.
- Upload được đổi tên ngẫu nhiên và không mount static.
- Media API chỉ nhận job/scene/keyframe/asset ID đã validate.
- Serializer không trả filesystem path, API key hoặc raw provider request.
- ZIP chỉ đọc thư mục pack thuộc đúng job.
- Cleanup bỏ qua job đang active/queued.
- Pipeline có hard budget cho scene, keyframe, Vision bytes/pixels, segmentation calls, inpaint area, tổng disk và runtime; vượt budget tạo failure code rõ ràng.

## 7. Chất lượng và đánh giá

Job “chạy xong” chưa đủ để chứng minh công cụ tốt. Repo có evaluation độc lập UI để đo:

- boundary precision/recall/F1;
- element precision/recall theo type;
- bbox IoU;
- duplicate-kept và false-merge;
- mask IoU và boundary F-score;
- tracking ID switch/fragmentation;
- quality correlation với editor rating;
- reconstruction artifact và editor utility.

Synthetic benchmark có quyền sử dụng rõ ràng nằm trong `test/fixtures/decomposer/`.

## 8. Giới hạn và quyền tái sử dụng

Pixel không xuất hiện trong video không thể được phục hồi chắc chắn. Asset `RECONSTRUCTED` là approximation.

Video công khai không có nghĩa mọi element trong đó được phép tái sử dụng. Công cụ chỉ thực hiện extraction kỹ thuật, không cấp license và không tuyên bố nội dung là copyright-free.

Source discovery/reverse image search là module tương lai riêng; nếu được thêm, kết quả chỉ được gọi là “possible source” hoặc “visually similar source”.
