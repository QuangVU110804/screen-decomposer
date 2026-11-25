"""Local visible-watermark removal; no model, network or API key required."""
import json
import sys
from contextlib import redirect_stdout


def remove_regions(source, regions):
    import cv2
    import numpy as np

    if source.dtype != np.uint8 or source.ndim != 3 or source.shape[2] != 4:
        raise ValueError('Ảnh nguồn phải là RGBA 8-bit.')
    height, width = source.shape[:2]
    if width * height > 24_000_000:
        raise ValueError('Ảnh vượt giới hạn 24 MP.')
    if not isinstance(regions, list) or not 1 <= len(regions) <= 20:
        raise ValueError('Hãy chọn từ 1 đến 20 vùng watermark/logo.')
    area = 0
    for box in regions:
        if not isinstance(box, list) or len(box) != 4 or any(type(v) is not int for v in box):
            raise ValueError('Tọa độ vùng xóa phải là số nguyên pixel.')
        x, y, w, h = box
        if x < 0 or y < 0 or w < 1 or h < 1 or x + w > width or y + h > height:
            raise ValueError('Vùng xóa nằm ngoài ảnh hoặc không có diện tích.')
        area += w * h
    if area > min(width * height * 0.2, 1_000_000):
        raise ValueError('Tổng vùng xóa vượt 20% ảnh hoặc 1 triệu pixel.')
    mask = np.zeros((height, width), dtype=np.uint8)
    for x, y, w, h in regions:
        mask[y:y+h, x:x+w] = 255
    cv2.setNumThreads(2)
    # shortcut: neighboring pixels only; use a local generative model if texture reconstruction becomes necessary.
    filled = cv2.inpaint(np.ascontiguousarray(source[:, :, :3]), mask, 3, cv2.INPAINT_TELEA)
    result = source.copy()
    selected = mask != 0
    result[:, :, :3][selected] = filled[selected]
    return result


def main():
    try:
        import socket
        def no_network(*args, **kwargs):
            raise RuntimeError('Network access is disabled during local processing')
        socket.create_connection = no_network
        socket.socket.connect = no_network
        import numpy as np
        from PIL import Image
        request = json.loads(sys.stdin.readline())
        with Image.open(request['source']) as image:
            source = np.array(image.convert('RGBA'))
        if request.get('action') == 'detect':
            from watermark_detection import detect_watermarks
            with redirect_stdout(sys.stderr):
                suggestions, warnings = detect_watermarks(source)
            result = {'suggestions': suggestions, 'warnings': warnings}
        else:
            cleaned = remove_regions(source, request['regions'])
            Image.fromarray(cleaned).save(request['output'], format='PNG')
            result = {}
        print(json.dumps({'type': 'result', **result}), flush=True)
    except ImportError:
        print(json.dumps({'type':'error','message':'Thiếu engine ảnh local. Chạy npm run setup:local.'}), flush=True)
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'type':'error','message':str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
