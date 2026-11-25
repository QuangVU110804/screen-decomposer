import sys
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'workers'))
from watermark_detection import detect_watermarks


class WatermarkDetectionTests(unittest.TestCase):
    def test_faint_small_corner_sparkle_is_found_without_marking_a_diamond(self):
        source = Image.new('RGBA', (460, 300), (120, 120, 120, 255))
        icon = Image.open(ROOT / 'workers' / 'watermark-icons' / 'gemini.png').convert('L')
        icon = icon.resize((12, 12), Image.Resampling.LANCZOS)
        source.paste((127, 127, 127, 255), (430, 277, 442, 289), icon)
        ImageDraw.Draw(source).polygon([(399, 267), (405, 273), (399, 279), (393, 273)], fill=(127, 127, 127, 255))
        hits, _ = detect_watermarks(np.asarray(source))
        self.assertEqual(len(hits), 1, hits)
        self.assertEqual(hits[0]['label'], 'Gemini')
        x, y, w, h = hits[0]['box']
        self.assertTrue(425 <= x <= 430 and 272 <= y <= 277 and x+w >= 442 and y+h >= 289, hits)

    def test_icons_at_different_scales_and_polarities(self):
        rng = np.random.default_rng(18)
        source = np.full((440, 720, 4), (103, 123, 144, 255), np.uint8)
        source[:, :, :3] = np.clip(source[:, :, :3].astype(float) + rng.normal(0, 3, (440, 720, 1)), 0, 255)
        cases = [('tiktok', 'TikTok / Douyin', 33, 40, 97, 241),
                 ('youtube', 'YouTube', 47, 645, 88, 28),
                 ('gemini', 'Gemini', 31, 640, 390, 244)]
        for name, _, size, x, y, color in cases:
            icon = cv2.imread(str(ROOT / 'workers' / 'watermark-icons' / f'{name}.png'), cv2.IMREAD_GRAYSCALE)
            factor = size / max(icon.shape)
            mask = cv2.resize(icon, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA) / 255 * .72
            h, w = mask.shape
            original = source[y:y+h, x:x+w, :3]
            original[:] = original * (1 - mask[..., None]) + color * mask[..., None]
        hits, warnings = detect_watermarks(source)
        self.assertFalse(warnings)
        for _, label, size, x, y, _ in cases:
            self.assertTrue(any(hit['label'] == label and abs(hit['box'][0]-x) <= 8 and
                                abs(hit['box'][1]-y) <= 8 and max(hit['box'][2:]) <= size + 14
                                for hit in hits), hits)

    def test_recognizes_brand_text_and_adjacent_handle_but_not_plain_center_text(self):
        source = Image.new('RGBA', (800, 480), '#385671')
        draw = ImageDraw.Draw(source)
        font = ImageFont.load_default(size=30)
        draw.text((40, 363), 'Douyin', font=font, fill='white')
        draw.text((40, 397), '@studio_test', font=font, fill='white')
        draw.text((340, 222), 'YouTube', font=font, fill='white')
        draw.text((650, 35), 'YouTube', font=font, fill='white')
        draw.text((650, 392), 'Gemini', font=font, fill='white')
        hits, _ = detect_watermarks(np.asarray(source))
        self.assertCountEqual([hit['label'] for hit in hits], ['Douyin', 'YouTube', 'Gemini'], hits)
        _, y, _, height = next(hit['box'] for hit in hits if hit['label'] == 'Douyin')
        self.assertLess(y, 375)
        self.assertGreater(y + height, 419)
        self.assertLess(next(hit['box'][1] for hit in hits if hit['label'] == 'YouTube'), 45)

    def test_plain_background_returns_no_suggestions(self):
        source = np.full((180, 340, 4), (53, 90, 116, 255), np.uint8)
        self.assertEqual(detect_watermarks(source)[0], [])

    def test_tiktok_douyin_icon_groups_its_handle_without_a_brand_word(self):
        image = Image.new('RGBA', (800, 480), '#385671')
        icon = Image.open(ROOT / 'workers' / 'watermark-icons' / 'tiktok.png').convert('L')
        icon.thumbnail((33, 33))
        image.paste((255, 255, 255, 255), (40, 380, 40+icon.width, 380+icon.height), icon)
        ImageDraw.Draw(image).text((78, 385), '@studio_test', font=ImageFont.load_default(size=30), fill='white')
        hits, warnings = detect_watermarks(np.asarray(image))
        self.assertFalse(warnings)
        match = next(hit for hit in hits if hit['label'] == 'TikTok / Douyin')
        self.assertGreater(match['box'][0]+match['box'][2], 220)
