"""engine.run wiring with a stub MobileSAM: no model weights, fixed masks/logits/scores."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workers'))
import engine  # noqa: E402
import masks  # noqa: E402

WIDTH, HEIGHT = 1600, 1000  # balanced: proxy 1024 x 640, so tile_boxes is non-empty
BACK, FRONT, PAPER = (235, 160, 80), (40, 70, 200), (240, 240, 240)
# Amodal shapes in normalised coordinates: SAM sees the whole back ellipse, under the front one too.
SHAPES = {BACK: (.4, .5, .25, .25), FRONT: (.62, .5, .15, .15)}


def ellipse(shape, cx, cy, rx, ry):
    h, w = shape
    y, x = np.ogrid[:h, :w]
    return ((x+.5)/w-cx)**2/rx**2 + ((y+.5)/h-cy)**2/ry**2 <= 1


def source_image():
    rgb = np.zeros((HEIGHT, WIDTH, 3), np.uint8); rgb[:] = PAPER
    for colour in (BACK, FRONT):  # front drawn last
        rgb[ellipse((HEIGHT, WIDTH), *SHAPES[colour])] = colour
    return rgb


class FakePredictor:
    def __init__(self, model):
        from mobile_sam.utils.transforms import ResizeLongestSide
        self.transform = ResizeLongestSide(1024)
        self.proxy_shape = None

    def set_image(self, image):
        self.features = image  # stands in for the embedding; the engine swaps it back after tiles
        self.original_size = image.shape[:2]
        self.input_size = self.transform.get_preprocess_shape(*image.shape[:2], 1024)
        self.proxy_shape = self.proxy_shape or image.shape[:2]
        self.is_image_set = True

    def mask_at(self, x, y):
        image, (h, w) = self.features, self.original_size
        palette = np.array([PAPER, BACK, FRONT])  # resized edges blend colours: take the nearest
        nearest = np.argmin(((image[:, :, None, :].astype(int) - palette)**2).sum(axis=3), axis=2)
        y, x = min(h-1, int(y)), min(w-1, int(x))
        colour = tuple(int(v) for v in palette[nearest[y, x]])
        if colour in SHAPES and image.shape[:2] == self.proxy_shape:
            return ellipse((h, w), *SHAPES[colour])
        labels = cv2.connectedComponents((nearest == nearest[y, x]).astype(np.uint8))[1]  # tiles: visible part
        return labels == labels[y, x]

    def logits(self, mask):
        ih, iw = self.input_size
        padded = np.full((1024, 1024), -1, np.float32)
        padded[:ih, :iw] = cv2.resize(mask.astype(np.float32)*2-1, (iw, ih), interpolation=cv2.INTER_LINEAR)
        return cv2.resize(padded, (256, 256), interpolation=cv2.INTER_AREA)*8

    def predict_torch(self, point_coords, point_labels, boxes=None, mask_input=None, multimask_output=True, return_logits=False):
        import torch
        count = 3 if multimask_output else 1
        h, w = self.original_size
        scale = 1024 / max(h, w)
        found = [self.mask_at(x/scale, y/scale) for x, y in point_coords[:, 0].numpy()]
        masks_out = np.stack([[m]*count for m in found])
        low = np.stack([[self.logits(m)]*count for m in found])
        scores = np.tile(np.array([.95, .94, .93][:count], np.float32), (len(found), 1))
        return torch.as_tensor(masks_out), torch.as_tensor(scores), torch.as_tensor(low)


class FakeModel:
    def to(self, device):
        return self

    def eval(self):
        return self


class EngineRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.source = Path(cls.tmp.name) / 'source.png'
        Image.fromarray(source_image()).save(cls.source)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_engine(self, preset, name):
        import mobile_sam
        import torch
        output = Path(self.tmp.name) / name
        state = {'ready': False, 'segmentation': True, 'text': False, 'fingerprint': 'test', 'message': ''}
        emitted = []
        with mock.patch.object(engine, 'doctor', return_value=state), mock.patch.object(engine, 'emit', emitted.append), \
                mock.patch.object(mobile_sam, 'sam_model_registry', {'vit_t': lambda checkpoint: FakeModel()}), \
                mock.patch.object(mobile_sam, 'SamPredictor', FakePredictor),                 mock.patch.object(torch, 'set_num_interop_threads'):  # process-global: settable once per worker
            engine.run({'source': str(self.source), 'output': str(output), 'preset': preset})
        self.assertEqual(emitted[-1]['type'], 'result')
        result = json.loads((output / 'result.json').read_text(encoding='utf-8'))
        self.assertTrue(result['engines']['segmentation']['ok'], result['warnings'])
        elements = result['elements']
        ids = [element['id'] for element in elements]
        self.assertEqual(len(ids), len(set(ids)))
        for element in elements:
            for key in ('file', 'mask', 'thumbnail', 'sourceFile'):
                if element.get(key):
                    self.assertTrue((output / element[key]).is_file(), element[key])
            self.assertTrue(set(element.get('occludedBy', [])) <= set(ids))
        self.assertEqual(sorted(element['layerOrder'] for element in elements), list(range(len(elements))))
        self.assertTrue(all(type(element['layerOrder']) is int for element in elements))
        return result

    def test_fast_and_balanced_runs_write_a_consistent_bundle(self):
        for preset in ('fast', 'balanced'):
            with self.subTest(preset=preset):
                result = self.run_engine(preset, preset)
                regions = [e for e in result['elements'] if e['type'] == 'region']
                self.assertEqual(len(regions), 2)
                self.assertEqual(result['postprocess']['overlapPairs'], 1)
                back = next(e for e in regions if e.get('occludedBy'))
                front = next(e for e in regions if e['id'] in back['occludedBy'])
                self.assertLess(back['layerOrder'], front['layerOrder'])
                self.assertTrue(all(e['refinement']['alphaMethod'] == 'sam-logits-guided' for e in regions))
                if preset == 'balanced':
                    self.assertGreater(result['postprocess']['tilePrompts'], 0)

    def test_failed_soft_export_falls_back_to_hard_edge_then_skips(self):
        with mock.patch.object(masks, '_soft_alpha', side_effect=MemoryError('soft alpha')):
            result = self.run_engine('fast', 'fallback')
        regions = [e for e in result['elements'] if e['type'] == 'region']
        self.assertEqual(len(regions), 2)
        self.assertTrue(all('alphaMethod' not in e['refinement'] for e in regions))
        self.assertTrue(any('soft alpha' in warning for warning in result['warnings']))
        real = masks.export_mask

        def failing(*args, **kwargs):
            if kwargs.get('refine_edges') or kwargs.get('logits') is not None:
                raise RuntimeError('export broke')
            return real(*args, **kwargs)
        with mock.patch.object(masks, 'export_mask', failing):
            result = self.run_engine('fast', 'skipped')
        self.assertEqual([e for e in result['elements'] if e['type'] == 'region'], [])
        self.assertTrue(any('export broke' in warning for warning in result['warnings']))


if __name__ == '__main__':
    unittest.main()
