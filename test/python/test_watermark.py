import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workers'))
from watermark import remove_regions


class WatermarkTests(unittest.TestCase):
    def test_multiple_and_overlapping_marks_are_filled_without_changing_other_pixels(self):
        source = np.full((100, 160, 4), (35, 95, 160, 127), dtype=np.uint8)
        source[12:18, 12:20, :3] = 255
        source[62:68, 122:130, :3] = 255
        original = source.copy()
        result = remove_regions(source, [[10, 10, 12, 10], [120, 60, 12, 10], [12, 12, 8, 6]])
        mask = np.zeros((100, 160), bool)
        mask[10:20, 10:22] = True
        mask[60:70, 120:132] = True
        np.testing.assert_array_equal(result[~mask], original[~mask])
        np.testing.assert_array_equal(result[:, :, 3], original[:, :, 3])
        np.testing.assert_array_equal(source, original)
        self.assertLess(np.abs(result[12:18, 12:20, :3].astype(float) - (35, 95, 160)).mean(), 8)
        self.assertLess(np.abs(result[62:68, 122:130, :3].astype(float) - (35, 95, 160)).mean(), 8)

    def test_mark_touching_image_edge_preserves_dimensions_and_transparency(self):
        source = np.full((80, 100, 4), (40, 60, 80, 0), dtype=np.uint8)
        source[0:4, 0:4] = (255, 255, 255, 90)
        result = remove_regions(source, [[0, 0, 6, 6]])
        self.assertEqual(result.shape, source.shape)
        np.testing.assert_array_equal(result[:, :, 3], source[:, :, 3])
        np.testing.assert_array_equal(result[6:], source[6:])
        self.assertFalse(np.array_equal(result[:4, :4, :3], source[:4, :4, :3]))

    def test_invalid_and_expensive_regions_are_rejected(self):
        source = np.zeros((80, 100, 4), dtype=np.uint8)
        for regions in ([], None, [[-1, 0, 4, 4]], [[0, 0, 0, 4]], [[0, 0, True, 4]],
                        [[99, 0, 2, 2]], [[0, 0, 100, 80]], [[0, 0, 1, 1]] * 21):
            with self.subTest(regions=regions), self.assertRaises(ValueError):
                remove_regions(source, regions)


if __name__ == '__main__':
    unittest.main()
