"""Bounded mask filtering and source-pixel export. No semantic labels are inferred."""
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

MIN_REGION_FRACTION = .0015


def scale_text_boxes(boxes, proxy_shape, source_shape):
    if boxes is None or len(boxes) == 0:
        return np.empty((0, 4, 2), dtype=np.float32)
    boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4, 2)
    boxes[:, :, 0] *= source_shape[1] / proxy_shape[1]
    boxes[:, :, 1] *= source_shape[0] / proxy_shape[0]
    return boxes


class MaskFilter:
    def __init__(self, max_items=80):
        self.items = []
        self.max_items = max_items

    def accept(self, mask, score=0.0):
        pixels=int(np.count_nonzero(mask))
        area = pixels / mask.size
        if area < MIN_REGION_FRACTION or area > 0.94:
            return False
        edges = [mask[0, :], mask[-1, :], mask[:, 0], mask[:, -1]]
        if area > 0.35 and all(float(np.mean(edge)) > 0.6 for edge in edges):
            return False
        rows, columns = np.flatnonzero(mask.any(axis=1)), np.flatnonzero(mask.any(axis=0))
        bbox_ratio = ((rows[-1] - rows[0] + 1) * (columns[-1] - columns[0] + 1)) / mask.size
        if bbox_ratio > 0.95 and area > 0.5:
            return False
        small = cv2.resize(mask.astype(np.uint8), (128, 128), interpolation=cv2.INTER_NEAREST).astype(bool)
        for previous,previous_area,previous_score in self.items:
            intersection = np.count_nonzero(small & previous)
            union = np.count_nonzero(small | previous)
            # Retain either more complete coverage or better model quality for
            # global representative selection, including across point batches.
            if union and intersection / union > 0.88 and pixels<=previous_area and score<=previous_score:
                return False
        if len(self.items) >= self.max_items:
            return False
        self.items.append((small,pixels,score))
        return True


def _native_boundary(source, mask, left, top, right, bottom):
    height, width = source.shape[:2]
    mh, mw = mask.shape
    scale = max(height / mh, width / mw)
    if scale < 1.15:
        return None
    radius = min(7, max(2, int(np.ceil(scale))))
    margin = 3 * radius + 2
    left, top = max(0, left-margin), max(0, top-margin)
    right, bottom = min(width, right+margin), min(height, bottom+margin)
    if (right-left)*(bottom-top) > 1_200_000:
        return None
    px = (2*np.arange(left, right, dtype=np.int64)+1)*mw // (2*width)
    py = (2*np.arange(top, bottom, dtype=np.int64)+1)*mh // (2*height)
    native = mask[py[:, None], px].astype(np.uint8)
    refined = _snap_to_colors(source[top:bottom, left:right], native, radius)
    if refined is None or np.array_equal(refined, native):
        return None
    return left, top, right, bottom, refined * 255


def _sum3(x):
    """np.sum(x, axis=-1) for a C-contiguous ...x3 float array, same summation order, ~4x faster."""
    return x[..., 0] + x[..., 1] + x[..., 2]


def _snap_to_colors(image, native, radius):
    """Reassign band pixels whose colour clearly matches the local foreground or background."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
    inner = cv2.erode(native, kernel)
    outer = cv2.dilate(native, kernel)
    if not inner.any() or outer.all():
        return None
    color = cv2.cvtColor(np.ascontiguousarray(image[:, :, :3]), cv2.COLOR_RGB2LAB).astype(np.float32)
    window = (4*radius+3, 4*radius+3)
    # Only band pixels can change: box sums stay dense, the per-pixel tests run on the band alone.
    at = np.flatnonzero(outer != inner)

    def local_color(samples):
        weights = (samples & (image[:, :, 3] > 0)).astype(np.float32)
        count = cv2.boxFilter(weights, -1, window, normalize=False).reshape(-1)[at]
        total = cv2.boxFilter(color * weights[:, :, None], -1, window, normalize=False).reshape(-1, 3)[at]
        return total / np.maximum(count[:, None], 1), count

    foreground, fg_count = local_color(inner)
    background, bg_count = local_color(1-outer)
    band = (fg_count >= 4) & (bg_count >= 4)
    band &= _sum3((foreground-background)**2) >= 30**2
    pixels = color.reshape(-1, 3)[at]
    fg_dist = np.sqrt(_sum3((pixels-foreground)**2))
    bg_dist = np.sqrt(_sum3((pixels-background)**2))
    values = native.reshape(-1)[at]
    values[band & (bg_dist < 24) & (bg_dist + 12 < fg_dist)] = 0
    values[band & (fg_dist < 24) & (fg_dist + 12 < bg_dist)] = 1
    refined = native.copy()
    refined.reshape(-1)[at] = values
    return refined


def _bilinear(grid, ys, xs):
    """Separable bilinear sampling at pixel coordinates, clamped like torch align_corners=False."""
    def axis(coords, size):
        coords = np.clip(coords, 0, size-1)
        low = np.floor(coords).astype(np.int64)
        return low, np.minimum(low+1, size-1), (coords-low).astype(np.float32)
    x0, x1, wx = axis(xs, grid.shape[1])
    y0, y1, wy = axis(ys, grid.shape[0])
    rows = grid[y0]*(1-wy)[:, None] + grid[y1]*wy[:, None]
    return rows[:, x0]*(1-wx) + rows[:, x1]*wx


def upsample_logits(low_res, proxy_shape, source_shape, box):
    """Repeat SAM postprocess_masks (256 -> 1024 -> unpadded input -> image) at source size, inside box only."""
    resize = 1024 / max(proxy_shape)
    ih, iw = int(proxy_shape[0]*resize + .5), int(proxy_shape[1]*resize + .5)
    padded = cv2.resize(np.asarray(low_res, np.float32), (1024, 1024), interpolation=cv2.INTER_LINEAR)[:ih, :iw]
    left, top, right, bottom = box
    sh, sw = source_shape
    xs = (np.arange(left, right)+.5)*iw/sw - .5
    ys = (np.arange(top, bottom)+.5)*ih/sh - .5
    return _bilinear(padded, ys, xs).astype(np.float32)


def guided_alpha(guide_rgb, alpha, radius, eps=1e-3, at=None):
    """Colour guided filter (He et al.) with box filters. With `at` (bool mask) only those pixels
    are computed, zero elsewhere: box means stay dense, the per-pixel algebra runs where it is read."""
    guide = guide_rgb[:, :, :3].astype(np.float32) / 255
    p = alpha.astype(np.float32)
    window = (2*radius+1, 2*radius+1)
    mean = lambda value: cv2.boxFilter(value, -1, window, borderType=cv2.BORDER_REFLECT)
    at = np.ones(p.shape, bool) if at is None else at
    # a and b are read only by the final means, inside their window around an output pixel.
    near = np.flatnonzero(cv2.dilate(at.astype(np.uint8), np.ones(window, np.uint8)))
    pick = lambda value, index=near: value.reshape(-1, *value.shape[2:])[index]
    mean_i, mean_p = pick(mean(guide)), pick(mean(p))
    cov_ip = pick(mean(guide*p[:, :, None])) - mean_i*mean_p[:, None]
    var = lambda i, j: pick(mean(guide[:, :, i]*guide[:, :, j])) - mean_i[:, i]*mean_i[:, j] + (eps if i == j else 0)
    rr, rg, rb, gg, gb, bb = var(0, 0), var(0, 1), var(0, 2), var(1, 1), var(1, 2), var(2, 2)
    # Symmetric 3x3 inverse via the adjugate, per pixel.
    inv = np.stack([gg*bb-gb*gb, gb*rb-rg*bb, rg*gb-gg*rb, rr*bb-rb*rb, rb*rg-rr*gb, rr*gg-rg*rg], axis=1)
    det = rr*inv[:, 0] + rg*inv[:, 1] + rb*inv[:, 2]
    c0, c1, c2 = cov_ip[:, 0], cov_ip[:, 1], cov_ip[:, 2]
    a = np.stack([inv[:, 0]*c0 + inv[:, 1]*c1 + inv[:, 2]*c2,
                  inv[:, 1]*c0 + inv[:, 3]*c1 + inv[:, 4]*c2,
                  inv[:, 2]*c0 + inv[:, 4]*c1 + inv[:, 5]*c2], axis=1) / det[:, None]
    b = mean_p - _sum3(a*mean_i)
    a_full, b_full, out = np.zeros_like(guide), np.zeros_like(p), np.zeros_like(p)
    a_full.reshape(-1, 3)[near], b_full.reshape(-1)[near] = a, b
    index = np.flatnonzero(at)
    out.reshape(-1)[index] = np.clip(_sum3(pick(mean(a_full), index)*pick(guide, index)) + pick(mean(b_full), index), 0, 1)
    return out


def _soft_radii(mask_shape, source_shape):
    scale = max(source_shape[0]/mask_shape[0], source_shape[1]/mask_shape[1])
    # Guide radius capped at 2: wider windows blur crisp line art and low-contrast edges (radius 1 is too
    # narrow for an off-centre antialiased edge).
    return int(np.ceil(scale)) + 1, min(2, max(1, int(round(2*scale))))


def soft_box(mask, source_shape):
    """Source box of the mask with room for the soft band and guided-filter context."""
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return 0, 0, 0, 0
    (sh, sw), (mh, mw) = source_shape, mask.shape
    band, guide = _soft_radii(mask.shape, source_shape)
    margin = band + 2*guide
    return (max(0, int(np.floor(xs.min()*sw/mw)) - margin), max(0, int(np.floor(ys.min()*sh/mh)) - margin),
            min(sw, int(np.ceil((xs.max()+1)*sw/mw)) + margin), min(sh, int(np.ceil((ys.max()+1)*sh/mh)) + margin))


def _soft_alpha(source, mask, logits, box):
    """Guided soft alpha in a band around the proxy mask; certain pixels stay 1 and carved pixels
    beyond the occluder's soft edge stay 0."""
    left, top, right, bottom = box
    (sh, sw), (mh, mw) = source.shape[:2], mask.shape
    band_radius, guide_radius = _soft_radii(mask.shape, (sh, sw))
    px = (2*np.arange(left, right, dtype=np.int64)+1)*mw // (2*sw)
    py = (2*np.arange(top, bottom, dtype=np.int64)+1)*mh // (2*sh)
    native = mask[py[:, None], px].astype(np.uint8)
    # Pixels SAM called foreground but the (carved) proxy mask removed must stay
    # transparent. Decide at proxy resolution so ordinary edges are not carved.
    proxy_x, proxy_y = np.arange(px[0], px[-1]+1), np.arange(py[0], py[-1]+1)
    sam = _bilinear(logits, (proxy_y+.5)*sh/mh - .5 - top, (proxy_x+.5)*sw/mw - .5 - left) > 0
    carved = (sam & ~mask[py[0]:py[-1]+1, px[0]:px[-1]+1])[py[:, None]-py[0], px-px[0]]
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*band_radius+1, 2*band_radius+1))
    # The front object's feathered edge reaches band_radius px into the carved area; if the back were
    # carved there too, re-stacked layers would crack along the seam. Keep the back opaque (its own
    # source pixels, nothing synthesised) under that edge with a band_radius+1 px margin.
    reach = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (4*band_radius+3, 4*band_radius+3))
    under = carved & (cv2.dilate(native, reach) > 0)
    carved &= ~under
    certain = (cv2.erode(native, kernel) > 0) | under
    outer = (cv2.dilate(native, kernel) > 0) & ~carved
    band = outer & ~certain
    alpha = certain.astype(np.float32)
    guide = source[top:bottom, left:right]
    # Filter only tiles that hold band pixels to bound memory on large crops.
    # Context: guided filter reads 2*guide; the snap reads its band plus a (4*band+3)-px colour window.
    tile, context = 128, 2*guide_radius + 3*band_radius + 1
    window = (2*guide_radius+1, 2*guide_radius+1)
    for y in range(0, bottom-top, tile):
        for x in range(0, right-left, tile):
            inner = band[y:y+tile, x:x+tile]
            if not inner.any():
                continue
            y0, x0 = max(0, y-context), max(0, x-context)
            region = np.s_[y0:y+tile+context, x0:x+tile+context]
            # Feather a hard edge (He et al.): a sigmoid input leaves ghost levels
            # beside sharp edges, and SAM's edge can sit a few pixels off the
            # colour edge, so snap it to local colours first.
            hard = (certain[region] | (outer[region] & (logits[region] > 0))).astype(np.uint8)
            snapped = _snap_to_colors(guide[region], hard, band_radius)
            p = certain[region] | (outer[region] & (hard if snapped is None else snapped).astype(bool))
            at = np.zeros(p.shape, bool)
            at[y-y0:y-y0+inner.shape[0], x-x0:x-x0+inner.shape[1]] = inner
            q = guided_alpha(guide[region], p, guide_radius, at=at)
            # Edge-strength gate: where the guide is nearly flat (variance trace < eps) the filter
            # only smears the hard edge, so keep the snapped value there.
            colour = guide[region][:, :, :3].astype(np.float32) / 255
            mean = cv2.boxFilter(colour, -1, window, borderType=cv2.BORDER_REFLECT)
            flat = _sum3(cv2.boxFilter(colour*colour, -1, window, borderType=cv2.BORDER_REFLECT) - mean*mean) < 1e-3
            q = np.where(flat, p, q)[y-y0:y-y0+inner.shape[0], x-x0:x-x0+inner.shape[1]]
            alpha[y:y+tile, x:x+tile][inner] = q[inner]
    return alpha


def _fuse_block(rgb, alpha, need=None):
    """Foreground at `need` pixels (default all; zero elsewhere). Box blurs stay dense;
    the per-pixel arithmetic, which dominated, runs only where it is read."""
    image = rgb.astype(np.float32)
    a = alpha.astype(np.float32)[:, :, None]
    need = np.ones(alpha.shape, bool) if need is None else need

    def fuse(f, b, radius, at):
        k = (2*radius+1, 2*radius+1)
        pick = lambda x: x.reshape(len(alpha.flat), -1)[at]
        blur = lambda x: pick(cv2.blur(x, k, borderType=cv2.BORDER_REPLICATE).reshape(x.shape))
        a_at = pick(a)
        fb = blur(f*a)/(blur(a)+1e-5)
        bb = blur(b*(1-a))/(blur(1-a)+1e-5)
        return np.clip(fb + a_at*(pick(image) - a_at*fb - (1-a_at)*bb), 0, 255), bb

    # The radius-3 pass reads the radius-45 estimates only within its 7x7 window of a needed pixel.
    near = np.flatnonzero(cv2.dilate(need.astype(np.uint8), np.ones((7, 7), np.uint8)))
    f, b = np.zeros_like(image), np.zeros_like(image)
    f.reshape(-1, 3)[near], b.reshape(-1, 3)[near] = fuse(image, image, 45, near)
    out = np.zeros_like(image)
    index = np.flatnonzero(need)
    out.reshape(-1, 3)[index] = fuse(f, b, 3, index)[0]
    return out


def estimate_foreground(rgb, alpha, tile=384):
    """Blur-fusion foreground estimate (Germer 2020); only 0<alpha<1 pixels change.
    Tiled with a 48 px halo (45+3) so temporaries stay bounded and output equals the untiled result.
    uint8 alpha (0-255) is converted per tile: a full-frame float plane is ~90 MiB at 24 MP."""
    out = rgb.copy()
    h, w = alpha.shape
    halo = 48
    eight_bit = alpha.dtype == np.uint8
    edge = (alpha > 0) & (alpha < (255 if eight_bit else 1))
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            y1, x1 = min(h, y+tile), min(w, x+tile)
            core = edge[y:y1, x:x1]
            if not core.any():
                continue
            ys, xs = max(0, y-halo), max(0, x-halo)
            ye, xe = min(h, y1+halo), min(w, x1+halo)
            need = np.zeros((ye-ys, xe-xs), bool)
            need[y-ys:y1-ys, x-xs:x1-xs] = core
            block = alpha[ys:ye, xs:xe].astype(np.float32)/255 if eight_bit else alpha[ys:ye, xs:xe]
            f = _fuse_block(rgb[ys:ye, xs:xe], block, need)[y-ys:y1-ys, x-xs:x1-xs]
            out[y:y1, x:x1][core] = np.rint(f[core]).astype(np.uint8)
    return out


def append_warning(item, sentence):
    """Add a sentence to an element's edge warning without dropping or repeating what export said."""
    current = item.get('edgeWarning', '')
    if sentence not in current:
        item['edgeWarning'] = f'{current} {sentence}' if current else sentence


def export_mask(source, mask, output, element_id, exclusions=(), refine_edges=False, logits=None):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    source_h, source_w = source.shape[:2]
    mh, mw = mask.shape
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    left, top = int(np.floor(x0 * source_w / mw)), int(np.floor(y0 * source_h / mh))
    right, bottom = min(source_w, int(np.ceil(x1 * source_w / mw))), min(source_h, int(np.ceil(y1 * source_h / mh)))
    soft = logits is not None
    refined = _native_boundary(source, mask, left, top, right, bottom) if refine_edges and not soft else None
    if soft:
        left, top, right, bottom = soft_box(mask, (source_h, source_w))
        if logits.shape != (bottom-top, right-left):
            raise ValueError('logits must cover soft_box(mask, source shape)')
        # In place and logits released: a full-frame region at 24 MP is ~90 MiB per float plane.
        alpha = _soft_alpha(source, mask, logits, (left, top, right, bottom))
        del logits
        alpha *= 255
        alpha = np.rint(alpha, out=alpha).astype(np.uint8)
    elif refined is not None:
        left, top, right, bottom, alpha = refined
    else:
        alpha = cv2.resize(mask[y0:y1, x0:x1].astype(np.uint8) * 255, (right - left, bottom - top), interpolation=cv2.INTER_NEAREST)
    for (ex,ey),excluded in exclusions:
        ix0,iy0=max(left,ex),max(top,ey)
        ix1,iy1=min(right,ex+excluded.shape[1]),min(bottom,ey+excluded.shape[0])
        if ix1>ix0 and iy1>iy0:
            target=alpha[iy0-top:iy1-top,ix0-left:ix1-left]
            target[excluded[iy0-ey:iy1-ey,ix0-ex:ix1-ex]]=0
    crop = source[top:bottom, left:right].copy()
    crop[:, :, 3] = np.minimum(crop[:, :, 3], alpha)
    visible = crop[:, :, 3] > 0
    if not visible.any():
        return None
    if refine_edges or soft:
        rows = np.flatnonzero(visible.any(axis=1))
        cols = np.flatnonzero(visible.any(axis=0))
        y0, y1 = int(rows[0]), int(rows[-1]) + 1
        x0, x1 = int(cols[0]), int(cols[-1]) + 1
        crop, alpha = crop[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
        left, top = left+x0, top+y0
        right, bottom = left+x1-x0, top+y1-y0
    del visible
    original = source[top:bottom, left:right] if soft else None
    if soft:
        crop = crop.copy()
        crop[:, :, :3] = estimate_foreground(crop[:, :, :3], crop[:, :, 3])
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    filename, maskname, thumbname = f'{element_id}.png', f'{element_id}.mask.png', f'{element_id}.webp'
    image = Image.fromarray(crop)
    image.save(output / filename, compress_level=2)
    Image.fromarray(alpha).save(output / maskname, compress_level=2)
    image.thumbnail((320, 320))
    image.save(output / thumbname, 'WEBP', quality=85)
    result = {'id': element_id, 'type': 'region', 'label': 'Vùng ảnh', 'bbox': [left, top, right-left, bottom-top],
            'file': filename, 'mask': maskname, 'thumbnail': thumbname, 'outputKind': 'mask', 'needsReview': True,
            'selected': True, 'sourcePixelsOnly': True, 'edgeWarning': 'Biên mask được suy ra trên ảnh proxy; cần kiểm tra chi tiết.'}
    if soft:
        result['refinement'] = {'alphaMethod': 'sam-logits-guided'}
        result['edgeWarning'] = 'Biên alpha mềm suy ra từ mask và màu ảnh gốc; kiểm tra tóc, bóng và chi tiết nhỏ.'
        corrected = bool(np.any(crop[:, :, :3] != original[:, :, :3]))
        sourcename = f'{element_id}.source.png'
        Image.fromarray(original).save(output / sourcename, compress_level=2)
        result['sourceFile'] = sourcename
        result['sourcePixelsOnly'] = not corrected
        result['refinement']['colorCorrection'] = corrected
        if corrected:
            result['refinement']['colorCorrectionMethod'] = 'blur-fusion-foreground'
            result['edgeWarning'] += ' Màu RGB ở biên bán trong suốt đã được ước lượng để giảm lẫn nền; crop gốc được giữ riêng để chỉnh sửa.'
    elif refined is not None:
        result['refinement'] = {'sourceEdgeRefined': True}
        result['edgeWarning'] = 'Đã chỉnh mép theo màu ảnh gốc. Kiểm tra tóc, bóng và chi tiết nhỏ.'
    return result


def artifact_names(elements):
    """Output files result.json references; keep in sync with Node artifactNames (cache.js)."""
    return {name for item in elements for name in (item.get('file'), item.get('mask'), item.get('thumbnail'), item.get('sourceFile')) if name}


def export_text(source, polygon, output, element_id):
    """Use alpha only with smooth-background evidence; otherwise keep an honest crop."""
    from text_alpha import estimate_text_alpha
    h, w = source.shape[:2]
    points = np.asarray(polygon, dtype=float)
    padding=max(8,min(32,int((points[:,1].max()-points[:,1].min())*.4)))
    left, top = max(0, int(points[:, 0].min()) - padding), max(0, int(points[:, 1].min()) - padding)
    right, bottom = min(w, int(np.ceil(points[:, 0].max())) + padding), min(h, int(np.ceil(points[:, 1].max())) + padding)
    if right <= left or bottom <= top:
        return None
    original=source[top:bottom,left:right].copy()
    crop=original.copy()
    local_polygon=points-np.array([left,top])
    estimate=estimate_text_alpha(crop[:,:,:3],local_polygon)
    if estimate is not None:
        crop[:,:,3]=np.minimum(crop[:,:,3],estimate['alpha'])
        if 'foreground' in estimate:
            # Source-alpha clipping must not turn opaque ink into an estimated
            # edge. Only the inferred matte's fractional pixels are corrected.
            edge=(estimate['alpha']>0)&(estimate['alpha']<255)&(crop[:,:,3]>0)
            crop[:,:,:3][edge]=estimate['foreground'][edge]
    corrected=bool(np.any(crop[:,:,:3]!=original[:,:,:3]))
    image = Image.fromarray(crop)
    output = Path(output)
    output.mkdir(parents=True,exist_ok=True)
    filename, thumbnail = f'{element_id}.png', f'{element_id}.webp'
    sourcename=f'{element_id}.source.png'
    Image.fromarray(original).save(output/sourcename,compress_level=2)
    image.save(output / filename, compress_level=2)
    image.thumbnail((320, 320))
    image.save(output / thumbnail, 'WEBP', quality=85)
    result={'id': element_id, 'type': 'text-region', 'label': 'Vùng chữ', 'bbox': [left, top, right-left, bottom-top],
            'polygon': points.tolist(), 'file': filename, 'sourceFile':sourcename,'thumbnail': thumbnail, 'outputKind': 'mask' if estimate is not None else 'crop', 'needsReview': True,
            'selected': True, 'sourcePixelsOnly': not corrected, 'edgeWarning': 'Kiểm tra viền chữ và chi tiết nhỏ.' if estimate is not None else 'Nền phức tạp hoặc chưa đủ bằng chứng; giữ crop vùng chữ có thể còn nền.'}
    if estimate is not None:
        maskname=f'{element_id}.mask.png'
        Image.fromarray(crop[:,:,3]).save(output/maskname,compress_level=2)
        result['mask']=maskname
        result['refinement']={key:value for key,value in estimate.items() if key not in ('alpha','foreground')}
        result['refinement']['colorCorrection']=corrected
        if estimate.get('uncertainEffects'):
            result['edgeWarning']='Viền và bóng chữ được ước lượng từ ảnh; kiểm tra trên cả nền sáng và tối vì có thể còn màu nền hoặc thiếu hiệu ứng mờ.'
        if corrected:
            result['refinement']['colorCorrectionMethod']='estimated-translucent-edge-palette'
            result['edgeWarning']+=' Màu RGB ở biên bán trong suốt đã được ước lượng để giảm lẫn nền; crop gốc được giữ riêng để chỉnh sửa.'
    return result
