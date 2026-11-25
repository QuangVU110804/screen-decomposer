"""Compare watermark boxes against the manually annotated, local image set."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]


def intersection(a, b):
    x = max(0, min(a[0]+a[2], b[0]+b[2]) - max(a[0], b[0]))
    y = max(0, min(a[1]+a[3], b[1]+b[3]) - max(a[1], b[1]))
    return x*y


def score(expected, suggestions):
    remaining = set(range(len(expected)))
    wrong = partial = 0
    for suggestion in suggestions:
        box = suggestion['box']
        area = box[2]*box[3]
        candidates = []
        for i in remaining:
            target = expected[i]
            target_area = target[2]*target[3]
            overlap = intersection(box, target)
            iou = overlap / (area+target_area-overlap)
            if overlap / target_area >= .75 and iou >= .30:
                candidates.append((iou, i))
        if candidates:
            remaining.remove(max(candidates)[1])
        elif any(intersection(box, expected[i]) / area >= .35 for i in remaining):
            partial += 1
        else:
            wrong += 1
    return {'expected': len(expected), 'missed': len(remaining), 'wrong': wrong, 'partial': partial}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--module', type=Path, default=ROOT/'workers/watermark_detection.py')
    parser.add_argument('--split', choices=('tune', 'regression', 'holdout'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('detector', args.module.resolve())
    detector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(detector)
    manifest = ROOT/'test/fixtures/watermark-real.json'
    samples = []
    for sample in json.loads(manifest.read_text(encoding='utf-8')):
        if sample['split'] != args.split:
            continue
        file = ROOT/sample['file']
        with Image.open(file) as image:
            pixels = np.asarray(ImageOps.exif_transpose(image).convert('RGBA'))
        started = perf_counter()
        hits, warnings = detector.detect_watermarks(pixels)
        row = {**sample, **score(sample['boxes'], hits), 'suggestions': hits, 'warnings': warnings,
               'seconds': round(perf_counter()-started, 3), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
        samples.append(row)
        print(sample['id'], {key: row[key] for key in ('expected', 'missed', 'wrong', 'partial', 'seconds')}, hits, flush=True)
    result = {'split': args.split, 'moduleSha256': hashlib.sha256(args.module.read_bytes()).hexdigest(),
              'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(), 'samples': samples}
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
