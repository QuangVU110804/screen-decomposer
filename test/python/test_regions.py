import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workers'))
from regions import assemble_graphic, consolidate_candidates, drop_tile_edge_masks, refine_candidate, refine_candidates, refine_graphic_crop, refine_survivors, resolve_overlaps, tile_boxes, uncovered_points
from masks import MaskFilter


def candidate(name, mask, score=0.94):
    return {'id': name, 'mask': mask, 'scores': {'predictedIoU': score, 'stability': 0.96}}


class RegionQualityTests(unittest.TestCase):
    def test_edge_contour_adds_an_interior_point_for_a_missed_small_object(self):
        image = np.full((320, 480, 3), (32, 56, 88), np.uint8)
        cv2.circle(image, (120, 80), 13, (245, 176, 65), -1)
        grid = np.array([(x, y) for x in range(30, 480, 60) for y in range(20, 320, 40)])
        points = uncovered_points(image, grid)
        self.assertTrue(any((x - 120)**2 + (y - 80)**2 < 10**2 for x, y in points))
        self.assertEqual(uncovered_points(image, np.vstack([grid, [120, 80]])), [])

    def test_grid_point_on_object_rim_does_not_replace_an_interior_prompt(self):
        image = np.full((320, 480, 3), (32, 56, 88), np.uint8)
        cv2.circle(image, (120, 80), 16, (245, 176, 65), -1)
        points = uncovered_points(image, np.array([[134, 80], [340, 220]]))
        self.assertTrue(any((x - 120)**2 + (y - 80)**2 < 6**2 for x, y in points))

    def test_disconnected_group_yields_to_independently_proposed_objects(self):
        first = np.zeros((140, 180), np.uint8)
        second = np.zeros_like(first)
        cv2.ellipse(first, (55, 75), (23, 32), 12, 0, 360, 1, -1)
        cv2.ellipse(second, (120, 63), (25, 33), -10, 0, 360, 1, -1)
        rgb = np.full((140, 180, 3), 45, np.uint8)
        rgb[first > 0] = [225, 155, 90]
        rgb[second > 0] = [185, 120, 72]
        # Texture keeps these proposals from being classified as flat graphics.
        rgb[::3] //= 2
        group = candidate('group', (first | second).astype(bool), .96)
        left, right = candidate('left', first.astype(bool)), candidate('right', second.astype(bool))
        result = consolidate_candidates([group, left, right], rgb)
        self.assertEqual([c['id'] for c in result['candidates']], ['left', 'right'])
        incomplete = consolidate_candidates([group, left], rgb)
        self.assertIn('group', [c['id'] for c in incomplete['candidates']])
        third = np.zeros_like(first)
        third[13:27, 155:169] = 1
        group['mask'] |= third.astype(bool)
        incomplete = consolidate_candidates([group, left, right], rgb)
        self.assertIn('group', [c['id'] for c in incomplete['candidates']])

    def test_group_keeps_pixels_when_a_supporting_proposal_would_be_suppressed(self):
        first = np.zeros((180, 250), bool)
        second = np.zeros_like(first)
        first[50:100, 25:75] = True
        second[40:90, 145:195] = True
        partial = first.copy()
        partial[94:100] = False
        parent = np.zeros_like(first)
        parent[0:94, 0:110] = True
        parent[120:180, 0:110] = True
        parent[85:125, 0:10] = True
        rgb = np.full((180, 250, 3), 45, np.uint8)
        result = consolidate_candidates([
            candidate('parent', parent), candidate('group', first | second),
            candidate('partial', partial), candidate('second', second),
        ], rgb)
        self.assertTrue(any(c['mask'][98, 50] for c in result['candidates']))

    def test_noisy_extra_area_does_not_replace_a_clean_high_quality_whole_mask(self):
        clean=np.zeros((160,160),bool);clean[20:90,40:100]=True;clean[90:140,40:60]=True;clean[90:140,80:100]=True
        noisy=clean.copy();noisy[90:120,60:80]=True;noisy[132:140,88:100]=False
        rgb=np.full((160,160,3),[120,120,120],np.uint8)
        result=consolidate_candidates([candidate('clean',clean,.99),candidate('noisy',noisy,.91)],rgb)
        self.assertEqual([c['id'] for c in result['candidates']],['clean'])
    def test_streaming_filter_preserves_a_later_cleaner_high_quality_mask(self):
        clean=np.zeros((160,160),bool);clean[20:90,40:100]=True;clean[90:140,40:60]=True;clean[90:140,80:100]=True
        noisy=clean.copy();noisy[90:120,60:80]=True;noisy[132:140,88:100]=False
        rgb=np.full((160,160,3),[120,120,120],np.uint8)
        filt=MaskFilter();stream=[]
        for item in [candidate('noisy',noisy,.91),candidate('clean',clean,.99)]:
            if filt.accept(item['mask'],item['scores']['predictedIoU']):stream.append(item)
        result=consolidate_candidates(stream,rgb)
        self.assertEqual([c['id'] for c in result['candidates']],['clean'])
        self.assertFalse(filt.accept(clean,.98))
    def test_streaming_filter_does_not_discard_a_later_more_complete_object(self):
        whole=np.zeros((160,160),bool);whole[20:140,40:120]=True
        part=whole.copy();part[128:]=False
        rgb=np.full((160,160,3),[100,100,100],np.uint8)
        filt=MaskFilter();stream=[]
        for item in [candidate('part',part),candidate('whole',whole)]:
            if filt.accept(item['mask']):stream.append(item)
        result=consolidate_candidates(stream,rgb)
        self.assertEqual([c['id'] for c in result['candidates']],['whole'])
    def test_whole_object_wins_even_when_discovered_after_its_parts(self):
        rgb = np.full((160, 160, 3), (35, 30, 45), np.uint8)
        whole = np.zeros((160, 160), np.uint8)
        cv2.circle(whole, (70, 35), 18, 1, -1)
        cv2.rectangle(whole, (50, 45), (90, 100), 1, -1)
        cv2.rectangle(whole, (50, 95), (64, 145), 1, -1)
        cv2.rectangle(whole, (77, 95), (90, 145), 1, -1)
        rgb[whole > 0] = (170, 140, 160)
        torso = whole.astype(bool).copy(); torso[90:, :] = False
        legs = whole.astype(bool).copy(); legs[:95, :] = False
        result = consolidate_candidates([candidate('torso', torso), candidate('legs', legs), candidate('whole', whole.astype(bool), 0.91)], rgb)
        self.assertEqual([c['id'] for c in result['candidates']], ['whole'])
        self.assertEqual(result['stats']['suppressedParts'], 2)

    def test_compact_distinct_overlay_is_not_removed_as_anatomy(self):
        for color in [(20,110,250),(245,245,245)]:
            rgb = np.full((140, 140, 3), (30, 30, 35), np.uint8)
            parent = np.zeros((140, 140), np.uint8); parent[10:130, 25:115] = 1
            rgb[parent > 0] = (150, 150, 150)
            badge = np.zeros_like(parent); cv2.circle(badge, (70, 45), 12, 1, -1)
            rgb[badge > 0] = color
            result = consolidate_candidates([candidate('person', parent.astype(bool)), candidate('badge', badge.astype(bool))], rgb)
            self.assertEqual({c['id'] for c in result['candidates']}, {'person', 'badge'})

    def test_disconnected_chromatic_satellites_are_joined_without_filling_gaps(self):
        for color in [(255, 230, 5), (15, 120, 245)]:
            rgb = np.full((220, 260, 3), (65, 40, 55), np.uint8)
            seed = np.zeros((220, 260), np.uint8); cv2.circle(seed, (110, 110), 30, 1, -1)
            rgb[seed > 0] = color
            points = [(110, 58), (162, 110), (110, 162), (58, 110)]
            cv2.line(rgb, (110, 45), (110, 70), color, 7)
            cv2.line(rgb, (150, 110), (175, 110), color, 7)
            cv2.line(rgb, (110, 150), (110, 175), color, 7)
            cv2.line(rgb, (45, 110), (70, 110), color, 7)
            # Same-colored neighboring square is not a radial ray.
            rgb[65:77, 163:175] = color
            mask, meta = assemble_graphic(rgb, seed.astype(bool))
            self.assertGreaterEqual(meta['satellites'], 4)
            for x, y in points: self.assertTrue(mask[y, x])
            self.assertFalse(mask[110, 145])
            self.assertFalse(mask[70, 170])

    def test_multipart_overlay_is_removed_from_composite_but_not_reconstructed(self):
        rgb = np.full((200, 200, 3), (40, 30, 50), np.uint8)
        head = np.zeros((200, 200), np.uint8); cv2.circle(head, (100, 115), 65, 1, -1)
        rgb[head > 0] = (220, 140, 130)
        sun = np.zeros_like(head); cv2.circle(sun, (130, 65), 20, 1, -1)
        rgb[sun > 0] = (250, 230, 10)
        for a,b in [((130,24),(130,37)),((158,65),(173,65)),((100,65),(87,65)),((130,94),(130,106))]:cv2.line(rgb,a,b,(250,230,10),5)
        composite = head.astype(bool) | sun.astype(bool)
        result=consolidate_candidates([candidate('head',composite),candidate('sun',sun.astype(bool))],rgb)
        by_id={c['id']:c for c in result['candidates']}
        self.assertIn('head',by_id);self.assertIn('sun',by_id)
        self.assertFalse(by_id['head']['mask'][65,130])
        self.assertTrue(by_id['sun']['mask'][65,130])
        capped=consolidate_candidates([candidate('head',composite),candidate('sun',sun.astype(bool))],rgb,max_items=1)
        self.assertTrue(capped['candidates'][0]['mask'][65,130])
        self.assertNotIn('occludedBy',capped['candidates'][0])

    def test_graphic_edges_are_recovered_from_source_not_just_scaled_proxy(self):
        rgb=np.full((220,260,3),[65,40,55],np.uint8)
        seed=np.zeros((220,260),np.uint8);cv2.circle(seed,(110,110),30,1,-1);rgb[seed>0]=(255,230,5)
        for a,b in [((110,45),(110,70)),((150,110),(175,110)),((110,150),(110,175)),((45,110),(70,110))]:cv2.line(rgb,a,b,(255,230,5),7)
        proxy_seed=cv2.resize(seed,(130,110),interpolation=cv2.INTER_NEAREST)>0
        proxy_rgb=cv2.resize(rgb,(130,110))
        assembled,_=assemble_graphic(proxy_rgb,proxy_seed)
        source=np.dstack([rgb,np.full(rgb.shape[:2],255,np.uint8)])
        crop,mask,(left,top),meta=refine_graphic_crop(source,proxy_seed,assembled)
        self.assertTrue(meta['multipart'])
        self.assertTrue(mask[45-top,110-left]);self.assertFalse(mask[110-top,145-left])

    def test_refine_rejects_drifting_mask(self):
        old = np.zeros((100, 100), bool); old[20:60, 20:60] = True
        drift = np.zeros_like(old); drift[45:95, 45:95] = True
        item = {**candidate('a', old, .90), 'point': (40, 40), 'lowRes': None}
        calls = []
        def predict(point, box, mask_input):
            calls.append((point, box, mask_input))
            return drift, .97, np.zeros((256, 256), np.float32)
        refined = refine_candidate(predict, item)
        self.assertEqual(calls, [((40, 40), (20, 20, 60, 60), None)])
        self.assertIs(refined['mask'], old)
        self.assertFalse(refined['promptRefined'])
        self.assertNotIn('promptRefined', item)
        # A clean but lower-quality answer is rejected too.
        low = old.copy(); low[20:22] = False
        self.assertFalse(refine_candidate(lambda *a: (low, .87, None), item)['promptRefined'])

    def test_refine_accepts_tighter_mask_with_equal_score(self):
        old = np.zeros((100, 100), bool); old[20:60, 20:60] = True
        tight = old.copy(); tight[20:24] = False
        logits = np.full((256, 256), 4, np.float16)
        item = {**candidate('a', old, .90), 'point': (40, 40), 'lowRes': logits}
        new_logits = np.full((256, 256), 3, np.float32)
        seen = []
        def predict(point, box, mask_input):
            seen.append(mask_input)
            return tight, .89, new_logits
        refined = refine_candidate(predict, item)
        self.assertEqual(seen[0].shape, (1, 256, 256)); self.assertEqual(seen[0].dtype, np.float32)
        self.assertTrue(refined['promptRefined'])
        self.assertIs(refined['mask'], tight)
        self.assertEqual(refined['scores']['predictedIoU'], .89)
        self.assertIs(refined['lowRes'], new_logits)
        self.assertIs(item['mask'], old); self.assertEqual(item['scores']['predictedIoU'], .90)

    def test_refine_candidates_batches_by_logit_availability_and_keeps_order(self):
        base = np.zeros((100, 100), bool); base[20:60, 20:60] = True
        logits = np.full((256, 256), 4, np.float16)
        items = [{**candidate(name, base, .90), 'point': (40, 40), 'lowRes': low} for name, low in [('a', logits), ('b', None), ('c', logits)]]
        calls = []
        def predict(points, boxes, inputs):
            calls.append((len(points), None if inputs is None else (inputs.shape, inputs.dtype)))
            return [(base, .91, np.full((256, 256), 3, np.float16))] * len(points)
        result = refine_candidates(predict, items)
        self.assertEqual(calls, [(2, ((2, 1, 256, 256), np.float32)), (1, None)])
        self.assertEqual([c['id'] for c in result], ['a', 'b', 'c'])
        self.assertTrue(all(c['promptRefined'] for c in result))

    def test_refine_survivors_keeps_multipart_seed_unrefined(self):
        seed = np.zeros((100, 100), bool); seed[20:60, 20:60] = True
        tighter = seed.copy(); tighter[20:24] = False
        items = [{**candidate(name, seed, .90), 'point': (40, 40), 'lowRes': None} for name in ('sun', 'face', 'dropped')]
        selected = [{'id': 'sun', 'refinement': {'multipart': True}}, {'id': 'face', 'refinement': {'multipart': False}}]
        prompted = []
        def predict(points, boxes, inputs):
            prompted.extend(points)
            return [(tighter, .90, np.zeros((256, 256), np.float16))] * len(points)
        result = refine_survivors(predict, items, selected)
        self.assertEqual([c['id'] for c in result], ['sun', 'face'])
        self.assertEqual(len(prompted), 1)
        self.assertIs(result[0]['mask'], seed); self.assertFalse(result[0]['promptRefined'])
        self.assertIs(result[1]['mask'], tighter); self.assertTrue(result[1]['promptRefined'])

    def test_tile_boxes_skip_low_resolution_sources(self):
        self.assertEqual(tile_boxes((576, 1024), (720, 1280)), [])
        self.assertEqual(tile_boxes((576, 1024), (1080, 1920))[0][:2], (0, 0))

    def test_tile_boxes_cover_image_with_overlap(self):
        boxes = tile_boxes((576, 1024), (1080, 1920))
        self.assertEqual(len(boxes), 4)
        covered = np.zeros((1080, 1920), int)
        for x0, y0, x1, y1 in boxes:
            covered[y0:y1, x0:x1] += 1
        self.assertTrue((covered >= 1).all())
        self.assertEqual(covered[540, 960], 4)
        left, right = sorted({(b[0], b[2]) for b in boxes})
        self.assertGreaterEqual(left[1] - right[0], 0.2 * (left[1] - left[0]))
        self.assertEqual(right[1], 1920)

    def test_mask_touching_inner_tile_edge_is_dropped_but_image_edge_is_kept(self):
        tile = (0, 0, 1100, 620)  # top-left tile of a 1920x1080 image, 100x56 working mask
        mask = np.zeros((56, 100), bool)
        mask[0:10, 0:10] = True  # touches the image's top and left borders only
        self.assertFalse(drop_tile_edge_masks(mask, tile, (1080, 1920)))
        mask[20:30, 95:100] = True  # touches the inner right edge
        self.assertTrue(drop_tile_edge_masks(mask, tile, (1080, 1920)))
        inner = np.zeros((56, 100), bool); inner[54:56, 40:50] = True  # inner bottom edge
        self.assertTrue(drop_tile_edge_masks(inner, tile, (1080, 1920)))
        self.assertFalse(drop_tile_edge_masks(inner, (0, 460, 1100, 1080), (1080, 1920)))


def overlapping_characters():
    """Two tall (so not flat-graphic) ellipses; 'top' is drawn over 'bottom' with a dark outline."""
    rgb = np.full((160, 200, 3), (40, 45, 50), np.uint8)
    bottom = np.zeros((160, 200), np.uint8); cv2.ellipse(bottom, (75, 80), (24, 60), 0, 0, 360, 1, -1)
    top = np.zeros_like(bottom); cv2.ellipse(top, (108, 80), (24, 60), 0, 0, 360, 1, -1)
    rgb[bottom > 0] = (210, 130, 90)
    rgb[top > 0] = (120, 160, 225)
    # Line art lies inside the silhouette, so the mask edge is the outer edge of the outline.
    cv2.ellipse(rgb, (108, 80), (22, 58), 0, 0, 360, (15, 15, 20), 3)
    return rgb, bottom.astype(bool), top.astype(bool)


def work_item(item, index):
    mask = item['mask']
    return {**item, 'refinement': {'satellites': 0, 'multipart': False, 'flatGraphic': False}, '_index': index,
            '_area': int(mask.sum()), '_small': cv2.resize(mask.astype(np.uint8), (192, 192), interpolation=cv2.INTER_NEAREST).astype(bool)}


class OverlapTests(unittest.TestCase):
    def test_overlapping_characters_do_not_share_pixels(self):
        rgb, bottom, top = overlapping_characters()
        self.assertGreater(np.count_nonzero(bottom & top), .15 * bottom.sum())
        # Equal scores: only the image edge can decide, and the top ellipse wins even listed first.
        result = consolidate_candidates([candidate('top', top), candidate('bottom', bottom)], rgb)
        by_id = {c['id']: c for c in result['candidates']}
        self.assertEqual(np.count_nonzero(by_id['top']['mask'] & by_id['bottom']['mask']), 0)
        self.assertEqual(np.count_nonzero(by_id['top']['mask']), top.sum())
        self.assertEqual(by_id['bottom']['occludedBy'], ['top'])
        self.assertNotIn('occludedBy', by_id['top'])
        self.assertEqual(result['stats']['overlapPairs'], 1)

    def test_held_item_inside_character_without_contrast_is_not_cut(self):
        rgb = np.full((180, 140, 3), (35, 30, 45), np.uint8)
        body = np.zeros((180, 140), bool); body[20:160, 40:100] = True
        item = np.zeros_like(body); item[70:100, 55:85] = True
        rgb[body] = (170, 140, 160); rgb[item] = (160, 134, 152)
        result = consolidate_candidates([candidate('body', body), candidate('item', item)], rgb)
        by_id = {c['id']: c for c in result['candidates']}
        self.assertEqual(np.count_nonzero(by_id['body']['mask']), body.sum())
        self.assertNotIn('occludedBy', by_id['body'])
        # Even when both reach the overlap stage, a part-of pair is skipped.
        kept = [work_item(candidate('body', body), 0), work_item(candidate('item', item), 1)]
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        resolved = resolve_overlaps(kept, lab)
        self.assertEqual(resolved['pairs'], 0)
        self.assertEqual(kept[0]['mask'].sum(), body.sum()); self.assertEqual(kept[1]['mask'].sum(), item.sum())
        self.assertNotIn('occludedBy', kept[0]); self.assertNotIn('occludedBy', kept[1])

    def test_back_object_carved_to_a_sliver_is_not_kept(self):
        rgb = np.full((400, 400, 3), (40, 45, 50), np.uint8)
        back = np.zeros((400, 400), bool); back[100:200, 100:120] = True  # tall: not a flat graphic
        front = np.zeros_like(back); front[80:230, 102:162] = True  # hides 90% of the back
        rgb[back] = (210, 130, 90); rgb[front] = (120, 160, 225)
        result = consolidate_candidates([candidate('back', back), candidate('front', front)], rgb)
        self.assertEqual([c['id'] for c in result['candidates']], ['front'])  # 200 px left < 0.15% of 160000
        self.assertEqual(result['order'], ['front'])
        self.assertEqual(result['stats']['carvedSlivers'], 1)
        self.assertEqual(result['stats']['overlapPairs'], 1)

    def test_sliver_that_hides_another_object_is_kept_so_the_composite_has_no_hole(self):
        rgb = np.full((400, 400, 3), (40, 45, 50), np.uint8)
        back = np.zeros((400, 400), bool); back[60:340, 115:340] = True
        middle = np.zeros_like(back); middle[100:158, 100:140] = True  # in front of back, mostly hidden by front
        front = np.zeros_like(back); front[80:230, 10:136] = True
        rgb[back] = (90, 140, 90); rgb[middle] = (210, 130, 90); rgb[front] = (120, 160, 225)
        result = consolidate_candidates([candidate('back', back, .90), candidate('middle', middle, .93), candidate('front', front, .96)], rgb)
        covered = np.zeros_like(back)
        for item in result['candidates']:
            covered |= item['mask']
        self.assertEqual(int(np.count_nonzero((back | middle | front) & ~covered)), 0)

    def test_layer_order_puts_front_object_last(self):
        rgb, bottom, top = overlapping_characters()
        lone = np.zeros_like(bottom); lone[5:15, 5:15] = True
        result = consolidate_candidates([candidate('top', top), candidate('lone', lone), candidate('bottom', bottom)], rgb)
        order = result['order']
        self.assertEqual(sorted(order), ['bottom', 'lone', 'top'])
        self.assertLess(order.index('bottom'), order.index('top'))
        # A cycle (a over b over a) is broken by area: the larger goes further back.
        big, small = np.zeros((60, 60), bool), np.zeros((60, 60), bool)
        big[0:40, 0:40] = True; small[20:50, 20:50] = True
        kept = [work_item(candidate('small', small), 0), work_item(candidate('big', big), 1)]
        kept[0]['occludedBy'], kept[1]['occludedBy'] = ['big'], ['small']
        self.assertEqual(resolve_overlaps(kept, np.zeros((60, 60, 3), np.float32))['order'][0], 'big')


class SpeedupEquivalenceTests(unittest.TestCase):
    """Task 6a: each speed-up equals the formulation it replaced."""
    def masks(self):
        found = []
        for box in ((0, 0, 30, 25), (50, 40, 80, 60), (70, 90, 100, 100), (20, 50, 22, 52)):
            mask = np.zeros((100, 100), bool)
            x0, y0, x1, y1 = box
            mask[y0:y1, x0:x1] = True
            mask[y0, x0] = False
            found.append(mask)
        line = np.zeros((100, 100), bool); line[30, 10:90] = True  # erodes to nothing: fallback to the mask
        return found + [line]

    def test_bbox_matches_nonzero(self):
        from regions import _bbox
        for mask in self.masks() + [np.zeros((100, 100), bool)]:
            ys, xs = np.nonzero(mask)
            expected = (int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1) if len(xs) else (0, 0, 0, 0)
            self.assertEqual(_bbox(mask), expected)

    def test_windowed_interior_and_masked_hsv_match_full_image(self):
        from regions import _bbox
        rgb = np.random.default_rng(4).integers(0, 256, (100, 100, 3), dtype=np.uint8)
        lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        kernel = np.ones((3, 3), np.uint8)
        for mask in self.masks():
            full = cv2.erode(mask.astype(np.uint8), kernel) > 0
            x0, y0, x1, y1 = _bbox(mask)
            window = np.s_[max(0, y0-1):y1+1, max(0, x0-1):x1+1]
            interior = cv2.erode(mask[window].astype(np.uint8), kernel) > 0
            np.testing.assert_array_equal(lab[window][interior if interior.any() else mask[window]], lab[full if full.any() else mask])
            np.testing.assert_array_equal(cv2.cvtColor(rgb[mask][None], cv2.COLOR_RGB2HSV)[0], cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)[mask])


if __name__ == '__main__':unittest.main()
