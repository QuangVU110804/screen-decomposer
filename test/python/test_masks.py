import sys
import unittest
from pathlib import Path
import tempfile
import cv2
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workers'))
from masks import MaskFilter, append_warning, artifact_names, estimate_foreground, export_mask, guided_alpha, scale_text_boxes, soft_box, upsample_logits

class MaskTests(unittest.TestCase):
    def test_native_refinement_removes_proxy_steps_and_preserves_source_pixels(self):
        y, x = np.ogrid[:160, :200]
        foreground = (x - 104)**2 + (y - 75)**2 <= 43**2
        source = np.full((160, 200, 4), (27, 42, 58, 255), np.uint8)
        source[foreground] = (236, 173, 79, 168)
        proxy = cv2.resize(foreground.astype(np.uint8), (40, 32), interpolation=cv2.INTER_AREA) > 0
        with tempfile.TemporaryDirectory() as tmp:
            def exported(item):
                left, top, width, height = item['bbox']
                result = np.zeros_like(source)
                result[top:top+height, left:left+width] = np.array(Image.open(Path(tmp) / item['file']))
                return result
            before = exported(export_mask(source, proxy, tmp, 'before'))
            after = exported(export_mask(source, proxy, tmp, 'after', refine_edges=True))
            errors_before = np.count_nonzero((before[:, :, 3] > 0) != foreground)
            errors_after = np.count_nonzero((after[:, :, 3] > 0) != foreground)
            self.assertLess(errors_after, errors_before / 3)
            visible = after[:, :, 3] > 0
            np.testing.assert_array_equal(after[visible], source[visible])

    def test_native_refinement_preserves_dark_outline_with_a_distinct_color(self):
        y, x = np.ogrid[:160, :200]
        distance = (x - 104)**2 + (y - 75)**2
        foreground = distance <= 43**2
        outline = foreground & (distance > 39**2)
        source = np.full((160, 200, 4), (27, 42, 58, 255), np.uint8)
        source[foreground] = (236, 173, 79, 255)
        source[outline] = (0, 0, 0, 255)
        proxy = cv2.resize(foreground.astype(np.float32), (40, 32), interpolation=cv2.INTER_AREA) >= .5
        with tempfile.TemporaryDirectory() as tmp:
            def retained(refine):
                item = export_mask(source, proxy, tmp, 'shape', refine_edges=refine)
                left, top, width, height = item['bbox']
                rgba = np.array(Image.open(Path(tmp) / item['file']))
                return np.count_nonzero(outline[top:top+height, left:left+width] & (rgba[:, :, 3] > 0))
            self.assertGreaterEqual(retained(True), retained(False))

    def test_empty_text_detections_are_a_valid_empty_result(self):
        self.assertEqual(scale_text_boxes(np.array([]), (540, 960), (1440, 2560)).shape, (0, 4, 2))
        boxes = np.array([[[3, 6], [9, 6], [9, 12], [3, 12]]])
        scaled = scale_text_boxes(boxes, (30, 30), (60, 90))
        self.assertEqual(scaled[0].tolist(), [[9, 12], [27, 12], [27, 24], [9, 24]])
    def test_removes_duplicate_but_keeps_meaningful_nested_region(self):
        outer = np.zeros((100, 100), dtype=bool)
        outer[10:80, 10:80] = True
        detail = np.zeros_like(outer)
        detail[20:45, 20:45] = True
        filt = MaskFilter(max_items=80)
        self.assertTrue(filt.accept(outer))
        self.assertFalse(filt.accept(outer.copy()))
        self.assertTrue(filt.accept(detail))
        self.assertFalse(filt.accept(np.ones_like(outer)))

    def test_surrounding_background_is_not_exported_as_foreground(self):
        background = np.ones((100, 100), dtype=bool)
        background[15:85, 20:80] = False
        self.assertFalse(MaskFilter().accept(background))
        broad = np.ones((100, 100), dtype=bool)
        broad[80:, :60] = False
        self.assertFalse(MaskFilter().accept(broad))

    def test_exports_source_alpha_without_filling_hidden_pixels(self):
        source = np.zeros((20, 40, 4), dtype=np.uint8)
        source[:, :, :3] = (240, 20, 30)
        source[:, :, 3] = 128
        mask = np.zeros((10, 20), dtype=bool)
        mask[2:8, 4:16] = True
        with tempfile.TemporaryDirectory() as tmp:
            result = export_mask(source, mask, Path(tmp), 'region_001')
            self.assertEqual(result['bbox'], [8, 4, 24, 12])
            image = np.array(Image.open(Path(tmp) / result['file']))
            self.assertEqual(image.shape, (12, 24, 4))
            self.assertEqual(int(image[:, :, 3].max()), 128)

    def test_source_refined_overlay_is_excluded_without_changing_visible_rgb(self):
        source=np.full((30,40,4),[200,80,90,255],np.uint8)
        mask=np.ones((15,20),bool)
        overlay=np.ones((5,7),bool)
        with tempfile.TemporaryDirectory() as tmp:
            result=export_mask(source,mask,Path(tmp),'region_001',exclusions=[((12,8),overlay)])
            rgba=np.array(Image.open(Path(tmp)/result['file']))
            self.assertEqual(int(rgba[9,13,3]),0)
            self.assertEqual(rgba[0,0].tolist(),[200,80,90,255])


def _sam_low_res(sdf, proxy_shape, gain=8.0):
    """Fake 256x256 SAM logits: signed distance (source px) sampled at low-res centres."""
    ph, pw = proxy_shape
    scale = 1024 / max(ph, pw)
    ih, iw = int(ph*scale+.5), int(pw*scale+.5)
    centre = (np.arange(256)+.5)*4  # continuous coordinates in the 1024 input
    return (gain*sdf(centre[None, :]/iw, centre[:, None]/ih)).astype(np.float16)


def _coverage(inside, shape, samples=8):
    """Supersampled area coverage of a shape given in normalised [0,1] coordinates."""
    h, w = shape
    offsets = (np.arange(samples)+.5)/samples
    total = np.zeros(shape, np.float64)
    for oy in offsets:
        for ox in offsets:
            total += inside((np.arange(w)[None, :]+ox)/w, (np.arange(h)[:, None]+oy)/h)
    return total/samples**2


class ArtifactNamesTests(unittest.TestCase):
    def test_keeps_source_file_and_tolerates_missing_fields(self):
        names = artifact_names([{'file': 'a.png', 'mask': 'a.mask.png', 'thumbnail': 'a.webp', 'sourceFile': 'a.source.png'}, {'file': 'b.png'}, {}])
        self.assertEqual(names, {'a.png', 'a.mask.png', 'a.webp', 'a.source.png', 'b.png'})


class SoftAlphaTests(unittest.TestCase):
    def export(self, source, low_res, proxy_shape, tmp, element_id='region_001', mask=None):
        full = upsample_logits(low_res, proxy_shape, proxy_shape, (0, 0, proxy_shape[1], proxy_shape[0]))
        mask = full > 0 if mask is None else mask
        box = soft_box(mask, source.shape[:2])
        item = export_mask(source, mask, tmp, element_id, logits=upsample_logits(low_res, proxy_shape, source.shape[:2], box))
        left, top, width, height = item['bbox']
        canvas = np.zeros(source.shape, np.uint8)
        canvas[top:top+height, left:left+width] = np.array(Image.open(Path(tmp) / item['file']))
        return item, canvas

    def disk_source(self, size, fg, bg, cx, cy, radius):
        inside = lambda x, y: (x-cx)**2 + (y-cy)**2 <= radius**2
        cover = _coverage(inside, (size, size))
        source = np.zeros((size, size, 4), np.uint8)
        source[:, :, :3] = np.rint(cover[:, :, None]*fg + (1-cover[:, :, None])*bg)
        source[:, :, 3] = 255
        sdf = lambda x, y: (radius - np.sqrt((x-cx)**2 + (y-cy)**2))*256  # low-res px of a square image
        return source, cover, sdf

    def test_soft_alpha_has_fractional_edge_on_antialiased_disk(self):
        source, cover, sdf = self.disk_source(400, np.array([235, 170, 80]), np.array([30, 45, 60]), .5, .5, .3)
        with tempfile.TemporaryDirectory() as tmp:
            item, rgba = self.export(source, _sam_low_res(sdf, (200, 200)), (200, 200), tmp)
        alpha = rgba[:, :, 3].astype(np.float64)
        edge = (cover > 0) & (cover < 1)
        fractional = (alpha[edge] > 0) & (alpha[edge] < 255)
        self.assertGreaterEqual(fractional.mean(), .60)
        self.assertLess(np.abs(alpha[edge]/255 - cover[edge]).mean(), .12)
        self.assertEqual(alpha[200, 200], 255)
        self.assertEqual(alpha[0, 0], 0)
        self.assertEqual(item['refinement']['alphaMethod'], 'sam-logits-guided')
        opaque = alpha == 255  # fractional edge RGB is decontaminated; opaque RGB is source
        np.testing.assert_array_equal(rgba[opaque, :3], source[opaque, :3])

    def test_soft_alpha_keeps_sharp_edge_on_flat_logo(self):
        source = np.full((400, 400, 4), (250, 250, 250, 255), np.uint8)
        source[100:300, 120:280, :3] = (200, 30, 40)
        for shift in (0, 2):  # SAM's edge may sit a few source pixels off the colour edge
            sdf = lambda x, y: (np.minimum(np.minimum(x*400-120, 280-x*400), np.minimum(y*400-100, 300-y*400))+shift)/400*256
            with self.subTest(shift=shift), tempfile.TemporaryDirectory() as tmp:
                _, rgba = self.export(source, _sam_low_res(sdf, (200, 200), gain=3.0), (200, 200), tmp)
                fractional = (rgba[:, :, 3] > 0) & (rgba[:, :, 3] < 255)
                self.assertLessEqual(int(fractional[110:290].sum(axis=1).max()), 4)  # two edges per row, <=2 px each
                self.assertLessEqual(int(fractional[:, 130:270].sum(axis=0).max()), 4)
                self.assertEqual(int(rgba[200, 200, 3]), 255)
                self.assertEqual(int(rgba[200, 110, 3]), 0)

    def square_case(self, fill, outline=None, size=400, half=.3, width=2):
        """Antialiased square on a near-white background, optionally with a dark line-art outline."""
        inside = lambda h: (lambda x, y: (abs(x-.5) < h) & (abs(y-.5) < h))
        cover = _coverage(inside(half), (size, size))
        colour = cover[:, :, None]*np.array(fill)
        if outline is not None:
            core = _coverage(inside(half-width/size), (size, size))
            colour = core[:, :, None]*np.array(fill) + (cover-core)[:, :, None]*np.array(outline)
        background = (245, 245, 245) if outline is not None else (135, 115, 100)
        source = np.zeros((size, size, 4), np.uint8)
        source[:, :, :3] = np.rint(colour + (1-cover[:, :, None])*np.array(background))
        source[:, :, 3] = 255
        return source, cover

    def feather(self, source, cover, shift, proxy=160):
        """Mean fractional px per edge on the middle rows, and SAD per row vs analytic coverage."""
        n = source.shape[0]
        sdf = lambda x, y: (np.minimum(.3-abs(x-.5), .3-abs(y-.5))*n + shift)/n*256
        with tempfile.TemporaryDirectory() as tmp:
            _, rgba = self.export(source, _sam_low_res(sdf, (proxy, proxy)), (proxy, proxy), tmp)
        alpha = rgba[:, :, 3]/255
        rows = slice(int(n*.45), int(n*.55))
        return ((alpha > 0) & (alpha < 1))[rows].sum(axis=1).mean()/2, np.abs(alpha-cover).sum()/n

    def test_soft_alpha_stays_narrow_on_low_contrast_edge(self):
        source, cover = self.square_case((150, 120, 90))  # on (135, 115, 100): below the snap contrast
        for shift in (0, 1.5):  # scale 2.5: guided radius was 5, an 8 px blur per edge
            with self.subTest(shift=shift):
                width, sad = self.feather(source, cover, shift)
                self.assertLessEqual(width, 4)
                self.assertLess(sad, 2.0)

    def test_soft_alpha_stays_narrow_on_line_art_outline(self):
        source, cover = self.square_case((250, 205, 175), outline=(20, 15, 25))  # 2 px dark outline
        for shift in (0, 1.5):
            with self.subTest(shift=shift):
                width, sad = self.feather(source, cover, shift)
                self.assertLessEqual(width, 4)
                self.assertLess(sad, .25)

    def test_soft_alpha_follows_colour_edge_when_sam_edge_is_off(self):
        source, cover, sdf = self.disk_source(400, np.array([235, 170, 80]), np.array([30, 45, 60]), .5, .5, .3)
        for shift in (-2, 2):
            with self.subTest(shift=shift), tempfile.TemporaryDirectory() as tmp:
                _, rgba = self.export(source, _sam_low_res(lambda x, y: sdf(x, y) + shift/400*256, (200, 200)), (200, 200), tmp)
                edge = (cover > 0) & (cover < 1)
                self.assertLess(np.abs(rgba[:, :, 3][edge]/255 - cover[edge]).mean(), .12)
                self.assertLess(np.abs(rgba[:, :, 3]/255 - cover).sum(), 400)

    def test_soft_alpha_never_exceeds_source_alpha(self):
        source, _, sdf = self.disk_source(400, np.array([235, 170, 80]), np.array([30, 45, 60]), .5, .5, .3)
        source[:, :, 3] = np.tile(np.linspace(0, 255, 400).astype(np.uint8), (400, 1))
        with tempfile.TemporaryDirectory() as tmp:
            _, rgba = self.export(source, _sam_low_res(sdf, (200, 200)), (200, 200), tmp)
        self.assertTrue(np.all(rgba[:, :, 3] <= source[:, :, 3]))
        opaque = rgba[:, :, 3] == 255
        np.testing.assert_array_equal(rgba[opaque, :3], source[opaque, :3])

    def test_soft_alpha_keeps_carved_pixels_transparent(self):
        source, _, sdf = self.disk_source(400, np.array([235, 170, 80]), np.array([30, 45, 60]), .5, .5, .3)
        low_res = _sam_low_res(sdf, (200, 200))
        mask = upsample_logits(low_res, (200, 200), (200, 200), (0, 0, 200, 200)) > 0
        mask[80:120, 80:120] = False  # an occluding graphic was carved out
        with tempfile.TemporaryDirectory() as tmp:
            _, rgba = self.export(source, low_res, (200, 200), tmp, mask=mask)
        # The back stays opaque for 2*band+1 = 7 px under the occluder's soft edge (no restack seam),
        # then the hidden area is a hard transparent hole.
        self.assertEqual(int(rgba[167:233, 167:233, 3].max()), 0)
        self.assertEqual(int(rgba[200, 160:167, 3].min()), 255)
        self.assertEqual(int(rgba[150, 200, 3]), 255)

    def test_carved_back_layer_restacks_without_seam(self):
        n = 400
        back_in = lambda x, y: (x-.4)**2 + (y-.5)**2 <= .25**2
        front_in = lambda x, y: (x-.65)**2 + (y-.5)**2 <= .15**2
        cb, cf = _coverage(back_in, (n, n)), _coverage(front_in, (n, n))
        rgb = cf[:, :, None]*(40, 70, 200) + (1-cf[:, :, None])*(cb[:, :, None]*(235, 160, 80) + (1-cb[:, :, None])*(240, 240, 240))
        source = np.zeros((n, n, 4), np.uint8); source[:, :, :3] = np.rint(rgb); source[:, :, 3] = 255
        sdf_b = lambda x, y: (.25 - np.sqrt((x-.4)**2 + (y-.5)**2))*256
        sdf_f = lambda x, y: (.15 - np.sqrt((x-.65)**2 + (y-.5)**2))*256
        interior = 1 - (1-cf)*(1-cb) > .999
        for proxy in (200, 160):
            with self.subTest(proxy=proxy), tempfile.TemporaryDirectory() as tmp:
                low = {k: _sam_low_res(s, (proxy, proxy)) for k, s in (('back', sdf_b), ('front', sdf_f))}
                full = {k: upsample_logits(v, (proxy, proxy), (proxy, proxy), (0, 0, proxy, proxy)) > 0 for k, v in low.items()}
                carved = full['back'] & ~full['front']  # resolve_overlaps: the back loses the shared pixels
                _, back = self.export(source, low['back'], (proxy, proxy), tmp, 'region_back', mask=carved)
                _, front = self.export(source, low['front'], (proxy, proxy), tmp, 'region_front')
                fa, ba = front[:, :, 3:]/255, back[:, :, 3:]/255
                composite = fa + ba*(1-fa)  # layerOrder: back first
                self.assertGreaterEqual(float(composite[interior].min()), .95)
                opaque = front[:, :, 3] == 255
                colour = (front[:, :, :3]*fa + back[:, :, :3]*ba*(1-fa)) / np.maximum(composite, 1e-6)
                np.testing.assert_array_equal(np.rint(colour[opaque]), source[opaque, :3])
                self.assertEqual(int(back[200, 215:300, 3].max()), 0)  # beyond the front's soft edge stays a hole

    def test_upsample_logits_matches_proxy_aspect(self):
        cx, cy, radius = 1850, 1010, 50
        source_shape, proxy_shape = (1080, 1920), (432, 768)
        sdf = lambda x, y: (radius - np.sqrt((x*1920-cx)**2 + (y*1080-cy)**2))/1920*256
        box = (1700, 900, 1920, 1080)
        logits = upsample_logits(_sam_low_res(sdf, proxy_shape), proxy_shape, source_shape, box)
        self.assertEqual(logits.shape, (180, 220))
        self.assertEqual(logits.dtype, np.float32)
        inside = logits > 0
        rows, cols = np.flatnonzero(inside.any(axis=1)) + box[1], np.flatnonzero(inside.any(axis=0)) + box[0]
        for found, expected in ((cols[0], cx-radius), (cols[-1]+1, cx+radius), (rows[0], cy-radius), (rows[-1]+1, min(1080, cy+radius))):
            self.assertLessEqual(abs(int(found) - expected), 1)

    def test_guided_alpha_follows_guide_edge(self):
        guide = np.zeros((40, 40, 3), np.uint8)
        guide[:, 20:] = 255
        ramp = np.clip((np.arange(40, dtype=np.float32) - 16) / 8, 0, 1)
        alpha = guided_alpha(guide, np.tile(ramp, (40, 1)), 4)
        self.assertEqual(alpha.dtype, np.float32)
        self.assertLess(float(alpha[20, 17]), float(np.tile(ramp, (40, 1))[20, 17]))
        self.assertGreater(float(alpha[20, 22]), float(ramp[22]))


class ForegroundTests(unittest.TestCase):
    def red_on_blue(self):
        rgb = np.zeros((40, 40, 3), np.uint8); rgb[:] = (0, 0, 255)
        alpha = np.zeros((40, 40), np.float32)
        rgb[:, :20] = (255, 0, 0); alpha[:, :19] = 1
        rgb[:, 19:21] = (128, 0, 128); alpha[:, 19:21] = .5  # edge: red/blue mix
        rgb[:, 19] = (128, 0, 128); alpha[:, 19] = .5
        return rgb, alpha

    def test_translucent_edge_color_moves_toward_foreground(self):
        rgb, alpha = self.red_on_blue()
        out = estimate_foreground(rgb, alpha)
        edge = (alpha > 0) & (alpha < 1)
        self.assertLessEqual(float(out[edge][:, 2].mean()), .5 * float(rgb[edge][:, 2].mean()))

    def test_tiled_matches_untiled_and_memory_is_bounded(self):
        import tracemalloc
        from masks import _fuse_block
        rng = np.random.default_rng(1)
        rgb = rng.integers(0, 256, (700, 900, 3), dtype=np.uint8)
        alpha = cv2.GaussianBlur((rng.random((700, 900)) > .5).astype(np.float32), (0, 0), 6)
        whole = rgb.copy(); edge = (alpha > 0) & (alpha < 1)
        whole[edge] = np.rint(_fuse_block(rgb, alpha)[edge]).astype(np.uint8)
        diff = np.abs(estimate_foreground(rgb, alpha, tile=200).astype(int) - whole.astype(int))
        self.assertLessEqual(int(diff.max()), 1)
        big = np.zeros((3000, 3000, 3), np.uint8); a = np.zeros((3000, 3000), np.float32); a[1500, :] = .5
        tracemalloc.start(); estimate_foreground(big, a); peak = tracemalloc.get_traced_memory()[1]; tracemalloc.stop()
        self.assertLess(peak, 130*2**20)  # 27 MB output copy + one tile's temporaries, independent of crop size

    def test_uint8_alpha_matches_float_alpha(self):
        rng = np.random.default_rng(4)
        rgb = rng.integers(0, 256, (300, 420, 3), dtype=np.uint8)
        alpha = np.rint(cv2.GaussianBlur((rng.random((300, 420)) > .5).astype(np.float32), (0, 0), 5)*255).astype(np.uint8)
        np.testing.assert_array_equal(estimate_foreground(rgb, alpha, tile=128), estimate_foreground(rgb, alpha.astype(np.float32)/255, tile=128))

    def test_opaque_pixels_are_untouched(self):
        rgb, alpha = self.red_on_blue()
        out = estimate_foreground(rgb, alpha)
        keep = (alpha == 0) | (alpha == 1)
        np.testing.assert_array_equal(out[keep], rgb[keep])

    def test_source_file_is_written_when_rgb_changes(self):
        size = 200
        yy, xx = np.mgrid[:size, :size]
        cover = np.clip(60 - np.hypot(xx - 99.5, yy - 99.5) + .5, 0, 1)
        source = np.zeros((size, size, 4), np.uint8)
        source[:, :, :3] = np.rint(cover[:, :, None]*np.array([220, 30, 30]) + (1-cover[:, :, None])*np.array([30, 30, 220]))
        source[:, :, 3] = 255
        low = ((60 - np.hypot(xx[::2, ::2]*2 - 99, yy[::2, ::2]*2 - 99))*.1).astype(np.float32)
        mask = upsample_logits(low, (size, size), (size, size), (0, 0, size, size)) > 0
        box = soft_box(mask, (size, size))
        with tempfile.TemporaryDirectory() as tmp:
            item = export_mask(source, mask, tmp, 'region_001', logits=upsample_logits(low, (size, size), (size, size), box))
            self.assertEqual(item['sourceFile'], 'region_001.source.png')
            left, top, w, h = item['bbox']
            np.testing.assert_array_equal(np.array(Image.open(Path(tmp)/item['sourceFile'])), source[top:top+h, left:left+w])
            out = np.array(Image.open(Path(tmp)/item['file']))
            self.assertTrue(np.any(out[:, :, :3] != source[top:top+h, left:left+w, :3]))
            self.assertFalse(item['sourcePixelsOnly'])
            self.assertTrue(item['refinement']['colorCorrection'])
            self.assertEqual(item['refinement']['colorCorrectionMethod'], 'blur-fusion-foreground')
            self.assertIn('Màu RGB ở biên bán trong suốt', item['edgeWarning'])
            # An occlusion note is appended once; the RGB-estimation note must survive.
            exported, note = item['edgeWarning'], 'Đã loại phần bị vật thể khác che; vùng bị che để trong suốt, không vẽ lại.'
            append_warning(item, note); append_warning(item, note)
            self.assertEqual(item['edgeWarning'], f'{exported} {note}')
            bare = {}; append_warning(bare, note)
            self.assertEqual(bare['edgeWarning'], note)


class SpeedupEquivalenceTests(unittest.TestCase):
    """Task 6a: each speed-up equals the formulation it replaced."""
    def test_sparse_fusion_matches_dense_reference(self):
        from masks import _fuse_block
        rng = np.random.default_rng(2)
        rgb = rng.integers(0, 256, (220, 260, 3), dtype=np.uint8)
        alpha = cv2.GaussianBlur((rng.random((220, 260)) > .5).astype(np.float32), (0, 0), 4)
        alpha[alpha < .3] = 0; alpha[alpha > .7] = 1
        image, a = rgb.astype(np.float32), alpha[:, :, None]

        def fuse(f, b, radius):  # dense blur fusion as it was before the sparse rewrite
            blur = lambda x: cv2.blur(x, (2*radius+1, 2*radius+1), borderType=cv2.BORDER_REPLICATE).reshape(x.shape)
            fb, bb = blur(f*a)/(blur(a)+1e-5), blur(b*(1-a))/(blur(1-a)+1e-5)
            return np.clip(fb + a*(image - a*fb - (1-a)*bb), 0, 255), bb
        dense = fuse(*fuse(image, image, 45), 3)[0]
        need = (alpha > 0) & (alpha < 1)
        need[:, 120:] = False  # a partial need mask, touching the block border on three sides
        self.assertTrue(need.any() and ((alpha > 0) & (alpha < 1) & ~need).any())
        sparse = _fuse_block(rgb, alpha, need)
        diff = np.abs(np.rint(sparse[need]) - np.rint(dense[need]))
        self.assertLessEqual(float(diff.max()), 1)
        self.assertFalse(sparse[~need].any())

    def edge_case(self):
        rng = np.random.default_rng(5)
        yy, xx = np.mgrid[:150, :170]
        disk = np.hypot(xx - 80, yy - 70) < 45
        image = np.zeros((150, 170, 4), np.uint8)
        image[:, :, :3] = np.where(disk[:, :, None], (220, 60, 40), (30, 90, 200))
        image[:, :, :3] = np.clip(image[:, :, :3] + rng.integers(-25, 26, (150, 170, 3)), 0, 255)
        image[:, :, 3] = 255
        image[:12, :, 3] = 0  # transparent source rows are excluded from local colours
        native = np.roll(disk, 3, axis=1).astype(np.uint8)  # SAM edge a few pixels off the colour edge
        return image, native

    def test_band_only_snap_matches_dense_reference(self):
        from masks import _snap_to_colors
        image, native = self.edge_case()
        radius = 4
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
        inner, outer = cv2.erode(native, kernel), cv2.dilate(native, kernel)
        color = cv2.cvtColor(np.ascontiguousarray(image[:, :, :3]), cv2.COLOR_RGB2LAB).astype(np.float32)

        def local_color(samples):  # dense formulation before the band-only rewrite
            weights = (samples & (image[:, :, 3] > 0)).astype(np.float32)
            count = cv2.boxFilter(weights, -1, (4*radius+3, 4*radius+3), normalize=False)
            total = cv2.boxFilter(color * weights[:, :, None], -1, (4*radius+3, 4*radius+3), normalize=False)
            return total / np.maximum(count[:, :, None], 1), count
        fg, fg_count = local_color(inner)
        bg, bg_count = local_color(1-outer)
        band = (outer != inner) & (fg_count >= 4) & (bg_count >= 4) & (np.sum((fg-bg)**2, axis=2) >= 30**2)
        fg_dist, bg_dist = np.sqrt(np.sum((color-fg)**2, axis=2)), np.sqrt(np.sum((color-bg)**2, axis=2))
        expected = native.copy()
        expected[band & (bg_dist < 24) & (bg_dist + 12 < fg_dist)] = 0
        expected[band & (fg_dist < 24) & (fg_dist + 12 < bg_dist)] = 1
        self.assertFalse(np.array_equal(expected, native))  # the case really snaps pixels
        np.testing.assert_array_equal(_snap_to_colors(image, native, radius), expected)

    def test_sparse_guided_alpha_matches_dense_reference(self):
        image, native = self.edge_case()
        radius, eps = 5, 1e-3
        guide, p = image[:, :, :3].astype(np.float32) / 255, native.astype(np.float32)
        mean = lambda value: cv2.boxFilter(value, -1, (2*radius+1, 2*radius+1), borderType=cv2.BORDER_REFLECT)
        mean_i, mean_p = mean(guide), mean(p)  # dense formulation before the sparse rewrite
        cov_ip = mean(guide*p[:, :, None]) - mean_i*mean_p[:, :, None]
        var = lambda i, j: mean(guide[:, :, i]*guide[:, :, j]) - mean_i[:, :, i]*mean_i[:, :, j] + (eps if i == j else 0)
        rr, rg, rb, gg, gb, bb = var(0, 0), var(0, 1), var(0, 2), var(1, 1), var(1, 2), var(2, 2)
        inv = np.stack([gg*bb-gb*gb, gb*rb-rg*bb, rg*gb-gg*rb, rr*bb-rb*rb, rb*rg-rr*gb, rr*gg-rg*rg], axis=2)
        det = rr*inv[:, :, 0] + rg*inv[:, :, 1] + rb*inv[:, :, 2]
        c0, c1, c2 = cov_ip[:, :, 0], cov_ip[:, :, 1], cov_ip[:, :, 2]
        a = np.stack([inv[:, :, 0]*c0 + inv[:, :, 1]*c1 + inv[:, :, 2]*c2, inv[:, :, 1]*c0 + inv[:, :, 3]*c1 + inv[:, :, 4]*c2,
                      inv[:, :, 2]*c0 + inv[:, :, 4]*c1 + inv[:, :, 5]*c2], axis=2) / det[:, :, None]
        b = mean_p - np.sum(a*mean_i, axis=2)
        dense = np.clip(np.sum(mean(a)*guide, axis=2) + mean(b), 0, 1)
        at = cv2.dilate(native, np.ones((9, 9), np.uint8)) != cv2.erode(native, np.ones((9, 9), np.uint8))
        at[:, 100:] = False
        sparse = guided_alpha(image, p, radius, eps, at=at)
        self.assertLessEqual(int(np.abs(np.rint(sparse[at]*255) - np.rint(dense[at]*255)).max()), 1)
        self.assertFalse(sparse[~at].any())
        self.assertLessEqual(int(np.abs(np.rint(guided_alpha(image, p, radius, eps)*255) - np.rint(dense*255)).max()), 1)

    def test_channel_sum_matches_numpy_sum(self):
        from masks import _sum3
        x = ((np.random.default_rng(3).random((50, 70, 3)) - .5) * 600).astype(np.float32)**2
        np.testing.assert_array_equal(_sum3(x), np.sum(x, axis=2))


if __name__ == '__main__':
    unittest.main()
