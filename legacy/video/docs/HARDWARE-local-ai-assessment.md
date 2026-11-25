# Đánh giá máy cho Florence-2 + SAM 2.1 + PaddleOCR

Kiểm tra trực tiếp ngày 23/10/2026 bằng CIM Windows, Python/pip và danh sách video trong workspace.

## Cấu hình đo được

| Thành phần | Kết quả |
|---|---|
| CPU | Intel Core i5-1035G1, 4 nhân / 8 luồng |
| RAM vật lý hệ thống báo | 11,77 GiB (máy khoảng 12 GB RAM) |
| RAM trống lúc kiểm tra | 3,25 GiB; biến động theo ứng dụng đang mở |
| GPU | Intel UHD Graphics, driver 31.0.101.2137 |
| AdapterRAM Windows báo | 1 GiB; không được diễn giải là VRAM rời/CUDA, GPU tích hợp còn dùng RAM chia sẻ |
| NVIDIA | Không xuất hiện trong Win32_VideoController; lệnh nvidia-smi không tồn tại |
| Ổ E trống | 56,78 GiB |
| Python | 3.10.11 đang dùng; launcher còn liệt kê Python 3.12 |
| Package trên Python đang dùng | Không tìm thấy torch, transformers, paddlepaddle, paddleocr, onnxruntime, openvino |

Không kiểm tra mọi virtual environment trên máy. Việc thiếu các package trên Python mặc định không chứng minh chúng không tồn tại trong môi trường khác.

## Kết luận

**Chưa phù hợp để benchmark đầy đủ bộ ba trong trạng thái máy hiện tại, hoặc chọn bộ ba làm pipeline xử lý video tự động mặc định.** Đây là đánh giá khả năng triển khai từ phần cứng/tài nguyên đang trống, không phải kết quả đo inference và không khẳng định CPU không thể chạy model.

- PaddleOCR có hướng inference CPU; đây là phần đáng thử riêng trước.
- Florence-2-base và SAM 2.1 nhỏ có thể được thử trên CPU, nạp tuần tự, mỗi lần một ảnh; chưa có số đo để kết luận latency hay mức RAM thực tế trên máy này.
- Không có GPU CUDA để dùng đường tăng tốc NVIDIA phổ biến. RAM trống 3,25 GiB tạo ít dư địa cho runtime, weights, activations, decode ảnh/video và hệ điều hành.
- Nạp đồng thời cả bộ ba hoặc chạy tracking nhiều frame có nguy cơ dùng pagefile và làm máy chậm. Dung lượng đĩa trống không thay thế RAM/VRAM.

SAM 2 upstream khuyến nghị Linux/WSL khi cài trên Windows và cho phép bỏ CUDA extension, với một số hậu xử lý mask bị bỏ qua. Điều này không phải cam kết CPU benchmark sẽ nhanh hoặc vừa bộ nhớ. [Hướng dẫn cài SAM 2](https://github.com/facebookresearch/sam2/blob/main/INSTALL.md).

Florence có model base để đánh giá trước; PaddleOCR phải chọn runtime CPU local, không dùng hosted OCR API. [Florence-2-base](https://huggingface.co/microsoft/Florence-2-base), [PaddleOCR installation](https://www.paddleocr.ai/main/en/version3.x/installation.html).

## Benchmark trong phiên này

**Chưa chạy inference benchmark**, vì yêu cầu người dùng là chạy khi cấu hình phù hợp và kiểm tra cho thấy máy đang thiếu dư địa RAM cho phép thử đầy đủ có ích. Chưa cài package hoặc tải model, chưa sửa pipeline ứng dụng, chưa phát sinh API AI.

Đã tìm thấy video thực sẵn có để dùng khi thử tiếp:

- `temp/jobs/76a31d73-ba82-4944-a6e4-77899ac9fc6d/source/source.webm` (~116 MB).
- `temp/jobs/9ebcaef1-914b-4c8a-9728-5c432934dfe8/source/source.webm` (~74 MB).

Các fixture synthetic cũng có nhưng không nên dùng làm bằng chứng chất lượng trên video thực. Chưa xem nội dung hai video hoặc xác định ground truth, nên chưa kết luận chúng đại diện đầy đủ bài toán.

## Phép thử nhỏ có ý nghĩa nếu tiếp tục trên máy này

Đây là đề xuất, chưa thực hiện:

1. Giải phóng RAM bằng cách người dùng đóng ứng dụng không cần thiết; không tự đóng trình duyệt/editor hay kết thúc process của người dùng.
2. Tạo venv riêng trong workspace. Chọn một đoạn video thực ngắn và 3–5 frame đại diện, không decode toàn video vào RAM.
3. Chạy PaddleOCR CPU trước. Sau đó thử Florence-2-base và SAM 2.1 tiny ở process riêng theo thứ tự, không giữ cả ba model trong RAM.
4. Ghi thời gian tải model riêng với thời gian inference, peak working set và mức RAM hệ thống trống; áp timeout và dừng khi áp lực bộ nhớ cao.
5. Xuất bbox/text/mask/crop để kiểm tra thủ công. Chưa thể suy rộng số đo một vài frame sang tracking toàn video 10 phút.

Nếu cần pipeline đầy đủ nhanh và ổn định, nên đánh giá trên một máy GPU có RAM/VRAM đủ cho workload cụ thể trước khi quyết định mua/nâng cấp. Phiên này không có cơ sở đưa ra mức VRAM tối thiểu, FPS hoặc cam kết chất lượng tương đương Claude.
