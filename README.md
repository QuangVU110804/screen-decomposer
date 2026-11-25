# Anime Element Studio

Ứng dụng local tự động quét ảnh review anime, tìm vùng nhân vật/graphic và vùng nghi có chữ, sau đó xuất asset. Không cần API key và không cần khoanh vùng trước.

## Chạy nhanh trên Windows

Cần cài sẵn [Node.js](https://nodejs.org) >=22.13 và [Python](https://www.python.org/downloads/) 3.10 hoặc 3.11 bản 64-bit. Sau đó bấm đúp **`start.bat`**.

Lần đầu, file này tự cài thư viện Node, môi trường Python và model (cần Internet, vài GB trống, khoảng 10–30 phút). Các lần sau nó chỉ khởi động app và mở http://127.0.0.1:3000 trong trình duyệt. Đóng cửa sổ dòng lệnh để tắt app. Nếu cổng 3000 đang bận, đặt `IMAGE_PORT=3001` trong process rồi chạy lại. App chỉ bind loopback, không mở ra mạng LAN.

Đã cài rồi thì cũng có thể chạy tay:

```powershell
npm.cmd run doctor
npm.cmd start
```

## Cài thủ công trên Windows

Cần Node.js >=22.13 và Python 3.10/3.11 64-bit (setup tự chọn `py -3.11`/`py -3.10` nếu có). App ảnh không cần FFmpeg, yt-dlp, Claude hoặc khóa dịch vụ AI.

```powershell
npm.cmd ci
npm.cmd run setup:local
npm.cmd run doctor
npm.cmd start
```

Setup tải dependency từ PyPI/PyTorch CPU, source MobileSAM đã pin commit và weights từ repository chính thức. Tải ban đầu cần Internet và vài GB trống cho môi trường Python và cài đặt tạm thời. Các gói tải về và ZIP cài MobileSAM được dọn sau khi sử dụng. Inference sau setup chạy offline; worker chặn kết nối mạng. Không cài model vào Python toàn hệ thống.

`requirements-local.txt` khóa dependency chính; `requirements-local.lock.txt` ghi môi trường đã kiểm thử. `models/manifest.json` ghi SHA256 weights. Setup kiểm tra SHA256 MobileSAM và trích OCR detector đi kèm wheel RapidOCR. MobileSAM được tích hợp bằng adapter, không nhúng cả repo vào source app.

Setup thu gọn bộ cài PyTorch CPU cho suy luận bằng cách bỏ tệp biên dịch C++ trong `.venv`. Model RapidOCR dùng chung tệp với bản trong wheel nếu hệ thống tệp hỗ trợ hard link. Trên ổ NTFS, dùng `--compact` để nén lossless các DLL và trọng số lớn.

```powershell
.venv/Scripts/python.exe scripts/trim-local-runtime.py --compact
npm.cmd run doctor
```

Nếu cần biên dịch extension C++, cài lại wheel đầy đủ `torch==2.5.1+cpu` bằng `pip install --force-reinstall`.

## Workflow

1. Thêm một JPG/PNG/WebP tĩnh, tối đa 20 MB / 24 megapixel.
2. Chọn **Nhanh** (lưới 8×8) hoặc **Kỹ · nhiều vật thể** (12×12), rồi bấm **Quét ảnh**.
3. Hệ thống tìm vùng chữ bằng OCR và quét mask bằng MobileSAM trên CPU. Bộ quét ưu tiên điểm nằm sâu trong vật thể nhỏ khi lưới chỉ chạm mép. Các vùng trùng hoặc gộp dư được lọc trước khi áp dụng giới hạn xuất. Khi có đủ tương phản, mép mask được đối chiếu với màu ảnh gốc: alpha mềm suy ra từ logit SAM + guided filter, màu RGB biên bán trong suốt được ước lượng (giữ `*.source.png` làm bản pixel nguồn). Preset Kỹ chạy thêm lượt quét 2×2 tile (4×4 điểm mỗi tile) khi chưa chạm giới hạn đề xuất; mask được tinh chỉnh theo điểm/box, và vùng chồng nhau được ghi `occludedBy` + `layerOrder` (phần bị che của vật thể phía sau để trong suốt).
4. Lọc vùng ảnh hoặc vùng chữ. Đưa con trỏ hoặc tiêu điểm bàn phím vào kết quả để thấy vị trí trên ảnh nguồn. **Chọn hết** áp dụng cho bộ lọc hiện tại, còn số cạnh **Tải ZIP** tính mọi vùng đã chọn. Mở từng vùng để xem alpha trên nền sáng, tối hoặc caro.
5. Tải PNG riêng hoặc ZIP gồm asset, mask và manifest. Kết quả lưu trong 24 giờ. Có thể hủy job, quét lại hoặc mở lịch sử.

Sau khi quét có thể mở **Chỉnh layer** để bật/tắt, đổi thứ tự/vị trí, xem riêng, dùng cọ/đa giác sửa mask, undo/redo và khôi phục bản đầu. **Nhập ảnh gốc B** bổ sung vật thể bị che khi bạn có nguồn đầy đủ; pixel không còn trong ảnh phẳng không thể lấy lại chính xác chỉ bằng cọ. Hiện điều khiển xem trước, ô Tải chọn PNG cho ZIP. Lưu ở kích thước gốc; di chuyển không resize ảnh.

`region` là vùng ảnh do model đề xuất, chưa tự gán tên nhân vật. Hậu xử lý ưu tiên mask toàn thể và gom graphic có các phần rời khi đủ bằng chứng. `text-region` có thể là PNG alpha hoặc crop còn nền; UI ghi rõ từng loại, không khẳng định khôi phục layer chữ gốc. Thumbnail chỉ là preview; PNG dùng pixel nguồn ở kích thước gốc đã normalize EXIF.

## Dung lượng lưu trữ

- App dọn lượt quét đã quá 24 giờ kể từ lần cập nhật cuối khi khởi động và mỗi giờ. Tải ZIP nếu cần lưu kết quả lâu hơn.
- Cache quét có giới hạn 512 MiB và ưu tiên giữ kết quả dùng gần đây. Khi hệ thống tệp hỗ trợ hard link, cache và lượt quét dùng chung dữ liệu PNG/WebP bất biến. Ảnh PNG được nén lossless.
- Mỗi layer giữ mask ban đầu và bản đang dùng. Bản cũ được dọn sau khi lưu hoặc đặt lại, sau khi các lượt tải đang đọc bản đó kết thúc.
- Đặt biến môi trường `IMAGE_DATA_DIR` thành đường dẫn tuyệt đối trước khi chạy `npm.cmd start` nếu muốn lưu các lượt quét mới ở ổ khác.

## Hiệu năng đã đo

Trên máy 4 nhân/8 luồng, RAM 11,77 GiB, CPU local:

- Bản khởi đầu, shot anime 2560×1440: các lần đo khoảng **24–71 giây**, 7 mask; worker peak khoảng **720–792 MiB**.
- Bản khởi đầu, ảnh graphic/chữ 1920×1080: khoảng **26,5 giây**, 21 mask và 5 crop vùng chữ. Số đo/chất lượng sau các bản cải thiện nằm trong các báo cáo cuối trang.
- Cache hit cùng ảnh/preset/engine: phần pipeline **47 ms**, chưa tính upload/normalize và mạng local.

Bản matting/đa vật thể (20/11/2026), A/B liên tiếp với bản trước trên ảnh họp 1920×1080 (máy đang tải nặng nên số tuyệt đối bị đội lên): Nhanh **+13,8%** (ngân sách ≤ +20%), Kỹ **+5,9%** (≤ +60%); worker peak ≤ 857 MiB; ảnh 24 MP (6000×4000) peak 1.009 MiB (Nhanh) / 1.153 MiB (Kỹ). Xem [báo cáo](docs/REPORT-detection-matting-2026-11-20.md).

Đây là phép thử đơn lẻ; không cam kết latency hay chất lượng cho mọi ảnh. Peak worker không bao gồm Node/trình duyệt. App chỉ chạy một job CPU mỗi lần, tối đa hai job chờ, dùng 2 thread và giới hạn 180 giây/giai đoạn model, 80 asset, 512 MB artifact/job. Cache tự vô hiệu khi model/code/package/preset thay đổi.

## Cấu trúc

```text
src/
  app.js, server.js         Express factory và startup
  config/                  Cấu hình riêng app ảnh
  features/images/         Validate và normalize ảnh
  features/jobs/           SQLite, queue, lifecycle, API
  features/elements/       Pipeline, budgets và ZIP
  integrations/python/     Worker process, protocol, timeout/cancel
  shared/                  File scope và atomic JSON
  web/                     Giao diện + CSS tokens + JS modules
workers/                   Inference CPU, mask/filter/export
scripts/                   Setup, doctor, benchmark và smoke test
models/                    Weights local + manifest SHA256
legacy/video/              Source/test/script/docs video cũ
```

Dữ liệu ảnh dùng `data/images/`; dữ liệu video gốc và `.env` được giữ riêng. Cấu hình app ảnh chỉ đọc `IMAGE_PORT`, `IMAGE_DATA_DIR`, `IMAGE_PYTHON`; không tải `.env` video.

## Kiểm thử

```powershell
npm.cmd test
.venv/Scripts/python.exe -m unittest discover -s test/python -v
npm.cmd run benchmark:images -- path/to/image.png fast
# App phải đang chạy để kiểm tra HTTP + inference thật:
node scripts/smoke-local.js path/to/image.png
```

Test Node API dùng worker deterministic để kiểm tra lifecycle và file scope. Smoke/benchmark dùng model thực. Báo cáo kiểm thử và giới hạn: [docs/REPORT-local-image-elements.md](docs/REPORT-local-image-elements.md).

## Xóa watermark / logo trên ảnh — local, không cần API key

Mở **Xóa watermark / logo** trong thanh bên, hoặc vào http://127.0.0.1:3000/watermark.html sau khi chạy `npm.cmd start`.

1. Chọn ảnh JPG, PNG hoặc WebP tĩnh (tối đa 20 MB / 24 MP).
2. App tự dò logo và chữ TikTok, Douyin, YouTube, Gemini. Dùng **Sửa** để đổi tọa độ hoặc kéo vẽ lại khung, **Bỏ** để bỏ vùng sai, hoặc kéo trên ảnh gốc để khoanh thêm. Nếu cần tìm thêm vùng, bấm **Dò watermark**.
3. Bấm **Xóa watermark / logo**, chuyển **Ảnh gốc / Sau khi xóa** để so sánh.
4. Bấm **Tải PNG đã xóa**. Đổi vùng chọn sẽ bỏ kết quả xem trước cũ; lần xử lý tiếp theo luôn dùng ảnh gốc đã chọn.

OpenCV dò mẫu biểu tượng và điền nền khi xóa. RapidOCR dùng model đi kèm bộ cài hiện có để đọc tên nền tảng và tài khoản. Cả hai chạy trên CPU local, không cần API key hay quét element. Có thể chọn tối đa 20 khung, tổng diện tích không quá 20% ảnh và 1 triệu pixel. Mỗi thao tác có thể hủy và được giới hạn 60 giây.

Các khung là gợi ý cho **watermark/logo nhìn thấy**. Biểu tượng nốt nhạc có thể mang nhãn **TikTok / Douyin** khi thiếu chữ phân biệt. Logo nhỏ, mờ hoặc lẫn họa tiết có thể bị bỏ sót hoặc khoanh nhầm. Chất lượng điền nền phụ thuộc vào chi tiết xung quanh. PNG giữ kích thước sau chuẩn hóa EXIF, alpha và pixel ngoài vùng chọn.

Kiểm thử và ảnh minh họa: [báo cáo xóa watermark](docs/REPORT-watermark-2026-10-27.md). Thuật toán: [tài liệu OpenCV](https://docs.opencv.org/4.12.0/d7/d8b/group__photo__inpaint.html).

Xem [kiểm thử trên ảnh công bố và khung hình trích](docs/REPORT-watermark-real-2026-11-08.md) để đối chiếu số vùng bỏ sót và khoanh nhầm trước và sau tinh chỉnh.

## Bản video cũ

```powershell
npm.cmd run start:legacy
npm.cmd run test:legacy
```

Dừng app ảnh trước nếu cùng cổng. Bản video vẫn cần FFmpeg/yt-dlp và cấu hình provider cũ. Code và tài liệu nằm trong `legacy/video/`, còn video nguồn, gói xuất và lịch sử nằm trong `temp/` và `data/jobs.db`. Để tạo fixture legacy, chạy `node legacy/video/scripts/make-fixtures.js` và `node legacy/video/scripts/make-decomposer-fixtures.js`; nếu `.env` chứa đường binary cũ, đặt `FFMPEG_PATH`/`FFPROBE_PATH` trong process theo máy hiện tại.

## Giới hạn

Đã bổ sung chọn mask toàn thể, giảm vùng trùng, ghép graphic nhiều phần và alpha chữ; xem [báo cáo chất lượng](docs/REPORT-element-quality-2026-10-26.md). Quét tự động vẫn có thể bỏ sót hoặc gộp/tách sai ở ảnh khác. Alpha mềm và ước lượng màu biên đã có nhưng chưa phải matting chuyên dụng: tóc mảnh, glow, bóng và bán trong suốt thật vẫn có thể sai. Khi hai vật thể chồng nhau, phần bị che của vật thể sau bị khoét thành trong suốt, không được dựng lại. Lượt tile của preset Kỹ chỉ chạy khi chưa đủ giới hạn đề xuất và làm Kỹ chậm hơn. Chưa có số recall/boundaryF/SAD trên ground truth vì chưa gán nhãn tay (xem `test/fixtures/masks/README.md`) — [báo cáo 20/11](docs/REPORT-detection-matting-2026-11-20.md). Không khôi phục phần bị che, layer gốc, font hay tên nhân vật. Mask toàn ảnh/nền rộng bị lọc để giảm kết quả không hữu ích, có thể ảnh hưởng foreground close-up. Cần kiểm tra PNG trước khi dùng lại.

Chữ trên nền phức tạp được xử lý thêm ở độ phân giải nguồn để giữ nét/dấu, viền tối và bóng có bằng chứng cục bộ; vùng chưa chắc giữ crop. Viền màu trên nền trơn được bảo toàn; viền nhiều màu/nền quá rối và quầng màu nền quanh bóng mờ vẫn có giới hạn. Xem [kiểm thử chữ trên ba ảnh thật](docs/REPORT-complex-text-2026-10-26.md).

Bản mới hỗ trợ thêm viền nhiều palette và giảm lẫn màu nền ở biên chữ bán trong suốt. Màu biên đó là ước lượng, được ghi rõ bằng metadata/cảnh báo; pixel mực đặc giữ nguyên, crop RGBA gốc được lưu riêng để tải/sửa. Xem [báo cáo layer và biên chữ 27/10](docs/REPORT-layers-text-2026-10-27.md) với ảnh thật trước/sau, giới hạn và kiểm thử native pixel.

Thư viện và nguồn model: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Bản tiếp theo khôi phục thêm nét chữ mảnh bằng tương phản cục bộ và giới hạn bóng theo bằng chứng lặp ở nhiều ký tự. Kiểm tra ảnh thật đạt 9/9 điểm nét mẫu so với 4/9 trước đó; bóng trên nền sáng vẫn còn ở một số vùng. Xem [báo cáo nét mảnh và quầng sáng](docs/REPORT-thin-text-light-2026-10-27.md), gồm ảnh trước/sau, đối chứng nhiều màu có suy giảm nhỏ, 37 kiểm thử Python/29 Node và pipeline thực.
