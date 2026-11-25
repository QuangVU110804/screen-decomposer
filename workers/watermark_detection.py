"""Suggest visible watermark boxes from bundled silhouettes and local OCR."""
import math
from pathlib import Path
import re
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image


ICONS = (('tiktok', 'TikTok / Douyin', .64, 12), ('youtube', 'YouTube', .85, 16), ('gemini', 'Gemini', .82, 16))
BRANDS = {'tiktok': 'TikTok', 'douyin': 'Douyin', '抖音': 'Douyin', 'youtube': 'YouTube', 'gemini': 'Gemini'}
BRAND_TEXT = re.compile(
    r'^(tik\s*tok|dou\s*yin|抖音|you\s*tube|gemini)\s*(?:(?:号|ID)\s*[:：]\s*[\w.\-]{2,40}|[:：·|]?\s*(?:@\s*[\w.\-]+)?)$',
    re.I,
)
HANDLE_TEXT = re.compile(r'@\s*[\w.\-]{2,40}')
DOUYIN_ACCOUNT = re.compile(r'抖\s*音\s*号\s*[:：]\s*[\w.\-]{0,40}')


@lru_cache(maxsize=3)
def _icon(name):
    icon = cv2.imread(str(Path(__file__).with_name('watermark-icons') / f'{name}.png'), cv2.IMREAD_GRAYSCALE)
    if icon is None:
        raise RuntimeError(f'Thiếu mẫu biểu tượng local: {name}.')
    return icon


def _high_pass(image):
    return cv2.GaussianBlur(image, (0, 0), .8) - cv2.GaussianBlur(image, (0, 0), 2.6)


def _near_edge(box, width, height):
    x0, y0, x1, y1 = box
    return min(x0, width - x1) <= width * .21 or min(y0, height - y1) <= height * .21


def _icon_hits(gray):
    height, width = gray.shape
    border = 8
    signal = _high_pass(cv2.copyMakeBorder(gray.astype(np.float32), border, border, border, border, cv2.BORDER_REPLICATE))
    for name, label, threshold, size in ICONS:
        icon = _icon(name)
        while size <= min(220, min(height, width) * .42):
            scale = size / max(icon.shape)
            w, h = (max(1, round(n * scale)) for n in icon.shape[::-1])
            mask = cv2.resize(icon, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32)
            pad = 4
            template = _high_pass(np.pad(mask, pad))
            scores = np.abs(cv2.matchTemplate(signal, template, cv2.TM_CCOEFF_NORMED))
            for _ in range(4):
                _, score, _, (px, py) = cv2.minMaxLoc(scores)
                if score < threshold:
                    break
                scores[max(0, py-h//2):py+h//2+1, max(0, px-w//2):px+w//2+1] = 0
                x, y = px + pad - border, py + pad - border
                box = (x, y, x+w, y+h)
                if not (0 <= x and 0 <= y and x+w <= width and y+h <= height):
                    continue
                if score < threshold + .10 and not _near_edge(box, width, height):
                    continue
                if signal[py:py+h+2*pad, px:px+w+2*pad].std() >= 2:
                    yield box, label, score
            size = max(size+2, round(size * 1.14))


def _four_sides_agree(template, patch):
    half = template.shape[0] // 2
    gains = []
    for y in (slice(0, half), slice(half, None)):
        for x in (slice(0, half), slice(half, None)):
            expected, observed = template[y, x], patch[y, x]
            expected = expected - expected.mean()
            observed = observed - observed.mean()
            power = float(np.sum(expected**2))
            signal = float(np.sum(expected*observed))
            if power <= 0 or signal < .30 * math.sqrt(power * float(np.sum(observed**2))) or signal < .010 * power:
                return False
            gains.append(signal / power)
    return max(gains) <= 2.8 * min(gains)


def _faint_gemini_corner(image):
    # The visible Gemini stamp sits near the lower right. Search here at native
    # resolution and require the same bright overlay on all four sides of the shape.
    width, height = image.size
    left = max(0, width - min(384, max(40, round(width*.20))))
    top = max(0, height - min(320, max(40, round(height*.24))))
    gray = np.asarray(image.crop((left, top, width, height)).convert('L'), dtype=np.float32)
    if np.ptp(gray) < 3:
        return None
    signal = _high_pass(gray)
    icon = _icon('gemini')
    best = None
    pad = 4
    size = 12
    while size <= min(128, min(gray.shape) - 2*pad):
        mask = cv2.resize(icon, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
        template = _high_pass(np.pad(mask, pad))
        scores = cv2.matchTemplate(signal, template, cv2.TM_CCOEFF_NORMED)
        span = size + 2*pad
        # Small texture intersections resemble the sparkle once down to a few pixels.
        minimum = .78 if size < 24 else .55
        for _ in range(4):
            _, score, _, (x, y) = cv2.minMaxLoc(scores)
            if score < minimum or (best and score <= best[2]):
                break
            if _four_sides_agree(template, signal[y:y+span, x:x+span]):
                x, y = left+x+pad, top+y+pad
                best = ((x, y, x+size, y+size), 'Gemini', score)
                break
            scores[max(0, y-size//3):y+size//3+1, max(0, x-size//3):x+size//3+1] = 0
        size = max(size+2, round(size*1.13))
    return best


def _ocr_rows(image):
    import onnxruntime
    from rapidocr_onnxruntime import RapidOCR

    onnxruntime.disable_telemetry_events()
    ocr = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1, det_limit_side_len=1280, det_limit_type='max')

    def read(rgb):
        result, _ = ocr(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), use_cls=False)
        for polygon, text, score in result or []:
            if score >= .75:
                points = np.asarray(polygon)
                yield (*np.floor(points.min(axis=0)).astype(int), *np.ceil(points.max(axis=0)).astype(int)), text.strip(), score

    rows = list(read(image))
    yield from rows
    height, width = image.shape[:2]
    rereads = 0
    for box, text, _ in rows:
        if text.casefold() != 'tube' or not _near_edge(box, width, height):
            continue
        x0, y0, x1, y1 = box
        w, h = x1-x0, y1-y0
        if not (5 <= w <= 110 and 4 <= h <= 70):
            continue
        badge = image[max(0, y0):y1, max(0, x0):x1].astype(np.int16)
        r, g, b = np.moveaxis(badge, -1, 0)
        if not r.size or np.mean((r-g > 28) & (r-b > 23)) < .18:
            continue
        # The legacy YouTube wordmark places dark “You” beside white “Tube” on red.
        # Re-read both together in a small crop before suggesting a box.
        left, top = max(0, x0-round(w*1.4)), max(0, y0-round(h*.55))
        right, bottom = min(width, x1+round(w*.3)), min(height, y1+round(h*.55))
        zoom = cv2.resize(image[top:bottom, left:right], None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        rereads += 1
        for (a, b, c, d), value, score in read(zoom):
            if re.fullmatch(r'you\s*tube', value, re.I):
                yield (left+a/3, top+b/3, left+c/3, top+d/3), value, score
        if rereads == 4:
            break


def _union(a, b):
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def _nearby(a, b):
    gap_x = max(a[0]-b[2], b[0]-a[2], 0)
    gap_y = max(a[1]-b[3], b[1]-a[3], 0)
    line_height = max(a[3]-a[1], b[3]-b[1])
    return gap_x <= line_height and gap_y <= line_height * .75


def _with_handle(box, rows):
    for handle, value, _ in rows:
        if ((HANDLE_TEXT.fullmatch(value) or DOUYIN_ACCOUNT.fullmatch(value)) and _nearby(box, handle) and
                handle[1] >= box[1] - .25*(box[3]-box[1]) and handle[3]-handle[1] <= 1.8*(box[3]-box[1])):
            return _union(box, handle)
    return box


def _overlap(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return intersection / min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))


def detect_watermarks(source):
    height, width = source.shape[:2]
    scale = min(1, 1440 / max(height, width), math.sqrt(1_200_000 / (height * width)))
    rgba = Image.fromarray(source)
    native = Image.new('RGB', (width, height), (128, 128, 128))
    native.paste(rgba, mask=rgba.getchannel('A'))
    image = native.resize((max(1, round(width*scale)), max(1, round(height*scale))), Image.Resampling.BOX) if scale < 1 else native
    image = np.asarray(image)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    if min(gray.shape) < 16:
        return [], []
    cv2.setNumThreads(2)
    h, w = gray.shape
    has_contrast = int(gray.max()) - int(gray.min()) >= 8
    icons = list(_icon_hits(gray)) if has_contrast else []
    corner = _faint_gemini_corner(native)
    if corner:
        (x0, y0, x1, y1), label, score = corner
        icons.append(((x0*w/width, y0*h/height, x1*w/width, y1*h/height), label, score))
    icons.sort(key=lambda hit: -hit[2])
    warnings = []
    try:
        rows = list(_ocr_rows(image)) if has_contrast and max(h, w) / min(h, w) <= 12 else []
    except Exception:
        rows = []
        warnings.append('OCR local chưa đọc được chữ. Kết quả chỉ gồm các biểu tượng tìm thấy.')
    candidates = [(_with_handle(box, rows) if label == 'TikTok / Douyin' else box, label, score)
                  for box, label, score in icons]
    for box, text, score in rows:
        match = BRAND_TEXT.fullmatch(text)
        if DOUYIN_ACCOUNT.fullmatch(text):
            label = 'Douyin'
        elif match:
            label = BRANDS[re.sub(r'\s+', '', match[1]).lower()]
        else:
            continue
        icon = next((hit for hit in icons if label in hit[1].split(' / ') and _nearby(box, hit[0])), None)
        if not icon and not _near_edge(box, w, h):
            continue
        group = _union(box, icon[0]) if icon else box
        if label in ('TikTok', 'Douyin'):
            group = _union(group, _with_handle(box, rows))
        candidates.append((group, label, 1 + score))

    accepted, suggestions = [], []
    area = 0
    # shortcut: silhouette and wordmark evidence only; calibrate with more exports when platform artwork changes.
    for box, label, _ in sorted(candidates, key=lambda hit: -hit[2]):
        x0, y0, x1, y1 = box
        pad = max(2, round((y1-y0) * .13))
        left = max(0, math.floor((x0-pad)*width/w))
        top = max(0, math.floor((y0-pad)*height/h))
        right = min(width, math.ceil((x1+pad)*width/w))
        bottom = min(height, math.ceil((y1+pad)*height/h))
        pixels = (right-left)*(bottom-top)
        if right <= left or bottom <= top or area + pixels > min(width*height*.2, 1_000_000):
            continue
        expanded = (left, top, right, bottom)
        if any(_overlap(expanded, prior) >= .55 for prior in accepted):
            continue
        accepted.append(expanded)
        suggestions.append({'box': [left, top, right-left, bottom-top], 'label': label})
        area += pixels
        if len(suggestions) == 20:
            break
    return suggestions, warnings
