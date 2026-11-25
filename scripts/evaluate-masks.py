"""Do chat luong mask: so element result.json voi ground truth gt.json.

python scripts/evaluate-masks.py <job-elements-dir> <gt-dir> [--json out.json]
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

TOLERANCE_PX = 3
BAND_PX = 8


def place(path, bbox, size):
    """Alpha of a crop pasted onto a full source-size canvas (clipped)."""
    w, h = size
    canvas = np.zeros((h, w), np.uint8)
    img = Image.open(path)
    alpha = np.asarray(img.getchannel('A') if 'A' in img.getbands() else img.convert('L'))
    x, y = bbox[:2]
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + alpha.shape[1], w), min(y + alpha.shape[0], h)
    if x1 > x0 and y1 > y0:
        canvas[y0:y1, x0:x1] = alpha[y0 - y:y1 - y, x0 - x:x1 - x]
    return canvas


def iou(a, b):
    a, b = a > 127, b > 127
    union = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / union if union else 0.0


def boundary(mask):
    m = (mask > 127).astype(np.uint8)
    return (m & ~cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)


def dist_to(b):
    return cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, 3)


def boundary_f(pred, gt):
    bp, bg = boundary(pred), boundary(gt)
    if not bp.any() or not bg.any():
        return 1.0 if not bp.any() and not bg.any() else 0.0
    precision = np.mean(dist_to(bg)[bp] <= TOLERANCE_PX)
    recall = np.mean(dist_to(bp)[bg] <= TOLERANCE_PX)
    return float(2 * precision * recall / (precision + recall)) if precision + recall else 0.0


def alpha_sad(pred, gt):
    bg = boundary(gt)
    if not bg.any():
        return 0.0
    band = dist_to(bg) <= BAND_PX
    return float(np.mean(np.abs(pred[band].astype(float) - gt[band].astype(float)) / 255))


def mean(values):
    return float(np.mean(values)) if values else 0.0


def evaluate(result_dir, gt_dir):
    result_dir, gt_dir = Path(result_dir), Path(gt_dir)
    gt = json.loads((gt_dir / 'gt.json').read_text(encoding='utf-8'))
    size = tuple(gt['image'])
    gts = [(o['name'], place(gt_dir / o['mask'], o['bbox'], size)) for o in gt['objects']]
    elements = json.loads((result_dir / 'result.json').read_text(encoding='utf-8'))['elements']
    preds = [(e['id'], place(result_dir / e['file'], e['bbox'], size)) for e in elements if e.get('type') != 'text-region']

    scores = sorted(((iou(g, p), gi, pi) for gi, (_, g) in enumerate(gts) for pi, (_, p) in enumerate(preds)), reverse=True)
    match, used = {}, set()
    for s, gi, pi in scores:
        if s >= .5 and gi not in match and pi not in used:  # below IoU 0.5 is not the same object
            match[gi] = (pi, s)
            used.add(pi)

    per_object = []
    for gi, (name, g) in enumerate(gts):
        if gi not in match:
            per_object.append({'name': name, 'element': None, 'iou': 0.0, 'boundaryF': 0.0, 'alphaSAD': None})
            continue
        pi, s = match[gi]
        p = preds[pi][1]
        per_object.append({'name': name, 'element': preds[pi][0], 'iou': s,
                           'boundaryF': boundary_f(p, g), 'alphaSAD': alpha_sad(p, g)})

    matched = [o for o in per_object if o['element']]
    n = len(gts) or 1
    duplicates = sum(1 for pi in range(len(preds)) if pi not in used
                     and any(iou(g, preds[pi][1]) > .5 for gi, (_, g) in enumerate(gts) if gi in match))
    return {
        'recall50': sum(o['iou'] >= .5 for o in per_object) / n,
        'recall75': sum(o['iou'] >= .75 for o in per_object) / n,
        'meanIoU': sum(o['iou'] for o in per_object) / n,
        'boundaryF': mean([o['boundaryF'] for o in matched]),
        'meanAlphaSAD': mean([o['alphaSAD'] for o in matched]),
        'duplicates': duplicates,
        'perObject': per_object,
    }


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('result_dir')
    ap.add_argument('gt_dir')
    ap.add_argument('--json')
    args = ap.parse_args()
    out = evaluate(args.result_dir, args.gt_dir)
    text = json.dumps(out, indent=2, ensure_ascii=False)
    if args.json:
        Path(args.json).write_text(text, encoding='utf-8')
    print(text)
