import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import cv2
import numpy as np
from PIL import Image

script = Path(__file__).resolve().parents[2] / 'scripts/evaluate-masks.py'
spec = importlib.util.spec_from_file_location('evaluate_masks', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DISCS = [('a', 60, 60), ('b', 140, 140)]  # name, cx, cy; radius 30 on a 200x200 canvas


def disc(cx, cy, r=30):
    m = np.zeros((200, 200), np.uint8)
    cv2.circle(m, (cx, cy), r, 255, -1)
    return m


def crop(mask):
    ys, xs = np.nonzero(mask)
    x, y, w, h = int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
    return mask[y:y + h, x:x + w], [x, y, w, h]


def write_gt(gt_dir):
    objects = []
    for name, cx, cy in DISCS:
        m, bbox = crop(disc(cx, cy))
        Image.fromarray(m).save(gt_dir / f'{name}.png')
        objects.append({'name': name, 'mask': f'{name}.png', 'bbox': bbox})
    (gt_dir / 'gt.json').write_text(json.dumps({'image': [200, 200], 'objects': objects}))


def write_result(res_dir, masks):
    elements = []
    for i, m in enumerate(masks):
        c, bbox = crop(m)
        rgba = np.dstack([np.full(c.shape + (3,), 128, np.uint8), c])
        Image.fromarray(rgba).save(res_dir / f'region_{i}.png')
        elements.append({'id': f'region_{i}', 'type': 'region', 'bbox': bbox, 'file': f'region_{i}.png'})
    elements.append({'id': 'text_0', 'type': 'text-region', 'bbox': [0, 0, 5, 5], 'file': 'missing.png'})
    (res_dir / 'result.json').write_text(json.dumps({'elements': elements}))


class EvaluateMasksTests(unittest.TestCase):
    def run_case(self, masks):
        with TemporaryDirectory() as tmp:
            gt, res = Path(tmp) / 'gt', Path(tmp) / 'res'
            gt.mkdir(); res.mkdir()
            write_gt(gt)
            write_result(res, masks)
            return module.evaluate(res, gt)

    def test_perfect_prediction_scores_one(self):
        r = self.run_case([disc(60, 60), disc(140, 140)])
        self.assertEqual(r['recall50'], 1.0)
        self.assertEqual(r['recall75'], 1.0)
        self.assertAlmostEqual(r['meanIoU'], 1.0)
        self.assertAlmostEqual(r['boundaryF'], 1.0)
        self.assertAlmostEqual(r['meanAlphaSAD'], 0.0)
        self.assertEqual(r['duplicates'], 0)
        self.assertEqual(len(r['perObject']), 2)

    def test_shifted_mask_lowers_boundary_f_but_not_recall50(self):
        shifted = self.run_case([disc(66, 60), disc(146, 140)])
        self.assertLess(shifted['boundaryF'], .9)
        self.assertEqual(shifted['recall50'], 1.0)

    def test_duplicate_is_counted_once_as_match_once_as_duplicate(self):
        dup = self.run_case([disc(60, 60), disc(60, 60), disc(140, 140)])
        self.assertEqual(dup['duplicates'], 1)
        self.assertEqual(dup['recall50'], 1.0)

    def test_missing_object_counts_as_zero_iou(self):
        r = self.run_case([disc(60, 60)])
        self.assertEqual(r['recall50'], 0.5)
        self.assertAlmostEqual(r['meanIoU'], 0.5)

    def test_low_iou_overlap_is_not_a_match(self):
        r = self.run_case([disc(90, 60), disc(140, 140)])  # IoU ~0.24 with 'a'
        self.assertIsNone(r['perObject'][0]['element'])
        self.assertEqual(r['perObject'][0]['iou'], 0.0)
        self.assertEqual(r['recall50'], 0.5)
        self.assertAlmostEqual(r['boundaryF'], 1.0)  # only the real match counts


if __name__ == '__main__':
    unittest.main()
