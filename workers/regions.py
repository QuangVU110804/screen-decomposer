"""Whole-region selection and conservative grouping of disconnected flat graphics."""
import cv2
import numpy as np
from masks import MIN_REGION_FRACTION


def uncovered_points(rgb, grid):
    """Find a few compact contours whose interior the uniform grid missed."""
    height, width = rgb.shape[:2]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    edges = cv2.Canny(lab[:, :, 0], 35, 90)
    for channel in (1, 2):
        edges |= cv2.Canny(lab[:, :, channel], 24, 60)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for area, contour in sorted(((cv2.contourArea(c), c) for c in contours), key=lambda entry: -entry[0]):
        if not height * width * MIN_REGION_FRACTION <= area <= height * width * .08:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        if min(w, h) < 8 or area < w * h * .30 or x == 0 or y == 0 or x+w == width or y+h == height:
            continue
        nearby = grid[(grid[:, 0] >= x) & (grid[:, 0] < x+w) & (grid[:, 1] >= y) & (grid[:, 1] < y+h)]
        if any(cv2.pointPolygonTest(contour, (float(px), float(py)), False) >= 0 for px, py in found):
            continue
        local = np.zeros((h+2, w+2), np.uint8)
        cv2.drawContours(local, [contour - np.array([x-1, y-1], np.int32)], -1, 1, cv2.FILLED)
        distance = cv2.distanceTransform(local, cv2.DIST_L2, 3)
        _, radius, _, (px, py) = cv2.minMaxLoc(distance)
        if radius >= 4 and all(distance[int(gy)-y+1, int(gx)-x+1] < radius*.40 for gx, gy in nearby):
            found.append((x+px-1, y+py-1))
        if len(found) == 12:
            break
    return found


def _bbox(mask):
    # Row/column any() is several times cheaper than nonzero() on full proxy masks.
    rows, cols = np.flatnonzero(mask.any(axis=1)), np.flatnonzero(mask.any(axis=0))
    return (int(cols[0]), int(rows[0]), int(cols[-1])+1, int(rows[-1])+1) if len(cols) else (0,0,0,0)


def _judge(candidate, mask, score, logits):
    old = candidate['mask']
    iou = np.count_nonzero(mask & old) / max(1, np.count_nonzero(mask | old))
    if score < candidate['scores']['predictedIoU'] - .02 or iou < .70:
        return {**candidate, 'promptRefined': False}
    stability = float((logits > 1).sum() / max(1, (logits > -1).sum()))
    return {**candidate, 'mask': mask, 'lowRes': logits, 'promptRefined': True,
            'scores': {'predictedIoU': round(float(score), 4), 'stability': round(stability, 4)}}


def refine_candidates(predict, candidates, batch=8):
    """Re-prompt with point, mask box and previous logits; keep only consistent, no-worse answers.

    predict(points, boxes, mask_inputs) -> [(mask, score, logits)], mask_inputs None or Bx1x256x256 float32.
    """
    results = [None] * len(candidates)
    for with_logits in (True, False):
        group = [i for i, c in enumerate(candidates) if (c.get('lowRes') is not None) == with_logits]
        for offset in range(0, len(group), batch):
            chunk = group[offset:offset+batch]
            inputs = np.stack([candidates[i]['lowRes'][None] for i in chunk]).astype(np.float32) if with_logits else None
            answers = predict([candidates[i]['point'] for i in chunk], [_bbox(candidates[i]['mask']) for i in chunk], inputs)
            for i, answer in zip(chunk, answers):
                results[i] = _judge(candidates[i], *answer)
    return results


def refine_candidate(predict, candidate):
    """Single-prompt form: predict(point, box, mask_input 1x256x256 or None) -> (mask, score, logits)."""
    return refine_candidates(lambda points, boxes, inputs: [predict(points[0], boxes[0], None if inputs is None else inputs[0])], [candidate])[0]


def refine_survivors(predict, candidates, selected):
    """Refine the proposals a first consolidation kept; multipart seeds stay as found so the
    final pass re-verifies the same graphic (and its occlusion carving)."""
    multipart = {c['id']: c['refinement']['multipart'] for c in selected}
    kept = [c for c in candidates if c['id'] in multipart]
    refined = iter(refine_candidates(predict, [c for c in kept if not multipart[c['id']]]))
    return [{**c, 'promptRefined': False} if multipart[c['id']] else next(refined) for c in kept]


def tile_boxes(proxy_shape, source_shape, grid=2, overlap=0.25):
    """Overlapping source tiles (x0, y0, x1, y1); none when the source adds little detail over the proxy."""
    if max(source_shape[:2]) < 1.5 * max(proxy_shape[:2]):
        return []
    spans = []
    for size in source_shape[:2]:
        tile = size / (grid - (grid-1) * overlap)
        spans.append([(int(round(start)), int(round(start + tile))) for start in np.linspace(0, size - tile, grid)])
    return [(x0, y0, x1, y1) for y0, y1 in spans[0] for x0, x1 in spans[1]]


def drop_tile_edge_masks(mask, tile_box, image_shape, margin=2):
    """True when a tile-local mask touches a cut (inner) tile edge, so the object continues outside."""
    x0, y0, x1, y1 = tile_box
    height, width = image_shape[:2]
    return bool((x0 > 0 and mask[:, :margin].any()) or (y0 > 0 and mask[:margin].any()) or
                (x1 < width and mask[:, -margin:].any()) or (y1 < height and mask[-margin:].any()))


def assemble_graphic(rgb, mask, lab=None):
    """Extend a compact chromatic seed with coherent radial satellites, never a hull."""
    meta = {'satellites': 0, 'multipart': False, 'flatGraphic': False}
    area = int(np.count_nonzero(mask))
    if area < 24:
        return mask, meta
    x0,y0,x1,y1 = _bbox(mask)
    width,height = x1-x0,y1-y0
    if not 0.45 <= width/max(1,height) <= 2.2:
        return mask, meta
    if lab is None:
        lab = cv2.cvtColor(rgb,cv2.COLOR_RGB2LAB).astype(np.float32)
    # Erode and sample inside the bbox plus a 1 px ring: identical to the full-image result.
    window = np.s_[max(0,y0-1):y1+1,max(0,x0-1):x1+1]
    interior = cv2.erode(mask[window].astype(np.uint8),np.ones((3,3),np.uint8)) > 0
    sample = lab[window][interior if interior.any() else mask[window]][::max(1,area//3000)]
    center = np.median(sample,axis=0)
    distances = np.linalg.norm(sample-center,axis=1)
    hsv_sample = cv2.cvtColor(rgb[mask][None],cv2.COLOR_RGB2HSV)[0]  # per-pixel: convert only the mask
    saturation = float(np.median(hsv_sample[:,1]))
    compact = float(np.mean(distances < 26))
    contours,_ = cv2.findContours(mask.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    perimeter = sum(cv2.arcLength(c,True) for c in contours)
    circularity = 4*np.pi*area/max(1,perimeter**2)
    if compact < 0.78 or circularity < 0.43:
        return mask, meta
    meta['flatGraphic'] = True
    # Achromatic badges may be independent too, but do not expand them by color
    # across a scene: white/gray commonly appears on unrelated hair and clothing.
    if saturation < 70:
        return mask,meta
    margin = max(width,height)
    left,top,right,bottom = max(0,x0-margin),max(0,y0-margin),min(mask.shape[1],x1+margin),min(mask.shape[0],y1+margin)
    local_lab = lab[top:bottom,left:right]
    tolerance = float(np.clip(np.percentile(distances,90)*1.7+8,16,34))
    similar = np.linalg.norm(local_lab-center,axis=2) < tolerance
    local_hsv = cv2.cvtColor(rgb[top:bottom,left:right],cv2.COLOR_RGB2HSV)
    similar &= local_hsv[:,:,1] > max(45,saturation*.55)
    n,labels,stats,centroids = cv2.connectedComponentsWithStats(similar.astype(np.uint8),8)
    overlap = np.bincount(labels[mask[top:bottom,left:right]],minlength=n)
    overlap[0] = 0
    body_id = int(overlap.argmax())
    if body_id == 0 or overlap[body_id] < area*.60:
        return mask, meta
    body_area = int(stats[body_id,cv2.CC_STAT_AREA])
    if not area*.55 <= body_area <= area*1.8:
        return mask, meta
    origin = centroids[body_id]
    radius = max(width,height)/2
    accepted, angles = [], []
    for label in range(1,n):
        if label == body_id:
            continue
        size = int(stats[label,cv2.CC_STAT_AREA])
        if not max(3,body_area*.002) <= size <= body_area*.20:
            continue
        radial = centroids[label]-origin
        distance = float(np.linalg.norm(radial))
        if not radius*1.12 <= distance <= radius*2.45:
            continue
        yy,xx = np.nonzero(labels == label)
        coords = np.column_stack((xx,yy)).astype(np.float32)
        values,vectors = np.linalg.eigh(np.cov(coords.T))
        elongation = np.sqrt(max(0,values[-1])/max(.1,values[0]))
        alignment = abs(float(vectors[:,-1] @ (radial/max(1,distance))))
        if elongation < 1.5 or alignment < .75:
            continue
        accepted.append(label)
        angles.append(float(np.arctan2(radial[1],radial[0])))
    if len(accepted) < 3:
        return mask, meta
    # A ray group must cover several directions rather than be a nearby text line.
    ordered = np.sort(np.mod(angles,2*np.pi))
    span = 2*np.pi-float(np.max(np.diff(np.r_[ordered,ordered[0]+2*np.pi])))
    if span < np.pi/2:
        return mask, meta
    refined = mask.copy()
    region = refined[top:bottom,left:right]
    region |= np.isin(labels,[body_id]+accepted)
    meta.update(satellites=len(accepted),multipart=True,method='palette-radial-components')
    return refined, meta


def _independent(candidate, parent, lab):
    meta = candidate['refinement']
    if meta['multipart']:
        return True
    if not meta['flatGraphic']:
        return False
    mask = candidate['mask']
    ring = (cv2.dilate(mask.astype(np.uint8),np.ones((9,9),np.uint8))>0) & ~mask & parent['mask']
    if ring.sum() < 12:
        return False
    contrast = np.linalg.norm(np.median(lab[mask],axis=0)-np.median(lab[ring],axis=0))
    return contrast > 25


def _contains_part(parent, item, lab):
    if item['_area'] >= parent['_area']*.92:
        return False
    small = item['_small']
    coverage = np.count_nonzero(small & parent['_small']) / max(1, np.count_nonzero(small))
    return coverage > .92 and not _independent(item, parent, lab)


def _redundant_group(item, proposals, lab):
    if item['refinement']['multipart']:
        return False
    _, labels, stats, _ = cv2.connectedComponentsWithStats(item['mask'].astype(np.uint8), 8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    components = np.flatnonzero(areas >= item['mask'].size * MIN_REGION_FRACTION)
    if len(components) < 2 or areas[components].sum() < item['_area']*.92:
        return False
    quality = item.get('scores', {}).get('predictedIoU', 0)
    for index in components:
        component = labels == index+1
        size = areas[index]
        for candidate in proposals:
            candidate_area = candidate['_area']
            if not size*.84 <= candidate_area <= size/.84 or candidate.get('scores', {}).get('predictedIoU', 0) < quality-.10:
                continue
            overlap = np.count_nonzero(component & candidate['mask'])
            if overlap >= .84*(size + candidate_area - overlap) and not any(
                _contains_part(parent, candidate, lab) for parent in proposals
            ):
                break
        else:
            return False
    return True


def refine_graphic_crop(source,seed,assembled):
    """Recover thin satellite edges within a bounded source-resolution crop."""
    x0,y0,x1,y1=_bbox(assembled)
    x0,y0=max(0,x0-3),max(0,y0-3)
    x1,y1=min(seed.shape[1],x1+3),min(seed.shape[0],y1+3)
    sh,sw=source.shape[:2];mh,mw=seed.shape
    left,top=int(np.floor(x0*sw/mw)),int(np.floor(y0*sh/mh))
    right,bottom=min(sw,int(np.ceil(x1*sw/mw))),min(sh,int(np.ceil(y1*sh/mh)))
    crop=source[top:bottom,left:right]
    working=crop[:,:,:3]
    scale=min(1.0,np.sqrt(1500000/max(1,working.shape[0]*working.shape[1])))
    if scale<1:
        working=cv2.resize(working,(max(1,round(working.shape[1]*scale)),max(1,round(working.shape[0]*scale))),interpolation=cv2.INTER_AREA)
    local_seed=cv2.resize(seed[y0:y1,x0:x1].astype(np.uint8),(working.shape[1],working.shape[0]),interpolation=cv2.INTER_NEAREST)>0
    mask,meta=assemble_graphic(working,local_seed)
    if not meta['multipart']:
        mask=cv2.resize(assembled[y0:y1,x0:x1].astype(np.uint8),(working.shape[1],working.shape[0]),interpolation=cv2.INTER_NEAREST)>0
        meta={'sourceRefined':False,'detailMethod':'proxy-components-fallback'}
    else:
        meta['sourceRefined']=True
    if mask.shape!=crop.shape[:2]:
        mask=cv2.resize(mask.astype(np.uint8),(crop.shape[1],crop.shape[0]),interpolation=cv2.INTER_NEAREST)>0
    return crop,mask,(left,top),meta


def _in_front(a, b, ma, mb, grad, lab):
    """True when a hides b: independence, then image edge along each contour inside the other, then score, then size."""
    ia, ib = _independent(a, b, lab), _independent(b, a, lab)
    if ia != ib:
        return ia
    kernel = np.ones((3, 3), np.uint8)
    edges = []
    for mask, other in ((ma, mb), (mb, ma)):
        ring = mask & ~(cv2.erode(mask.astype(np.uint8), kernel) > 0) & other
        edges.append(float(grad[ring].mean()) if ring.any() else 0.)
    if max(edges) > 0 and abs(edges[0]-edges[1]) >= .10*max(edges):
        return edges[0] > edges[1]
    qa, qb = a.get('scores', {}).get('predictedIoU', 0), b.get('scores', {}).get('predictedIoU', 0)
    if qa != qb:
        return qa > qb
    return (a['_area'], -a['_index']) < (b['_area'], -b['_index'])  # deterministic: smaller in front


def resolve_overlaps(kept, lab):
    """Give each shared pixel to the front object; the back one keeps a transparent hole, never inpainted.

    Returns the number of resolved pairs and ids ordered back to front.
    """
    height, width = lab.shape[:2]
    light = lab[:, :, 0].astype(np.float32)
    # Max over 3x3 so a proxy mask one pixel off the drawn edge still finds it.
    grad = cv2.dilate(cv2.magnitude(cv2.Sobel(light, cv2.CV_32F, 1, 0), cv2.Sobel(light, cv2.CV_32F, 0, 1)), np.ones((3, 3), np.uint8))
    masks = [c['mask'] for c in kept]  # decisions use the masks before this carving
    boxes = [_bbox(mask) for mask in masks]
    areas = [int(np.count_nonzero(mask)) for mask in masks]
    hidden = []
    for i in range(len(kept)):
        for j in range(i+1, len(kept)):
            a, b = kept[i], kept[j]
            if a['refinement']['multipart'] or b['refinement']['multipart']:
                continue  # verified graphics were carved above
            x0, y0 = max(boxes[i][0], boxes[j][0]), max(boxes[i][1], boxes[j][1])
            x1, y1 = min(boxes[i][2], boxes[j][2]), min(boxes[i][3], boxes[j][3])
            if x0 >= x1 or y0 >= y1:
                continue
            # One pixel of margin lets the erosion see each contour pixel's real neighbours.
            window = np.s_[max(0, y0-1):min(height, y1+1), max(0, x0-1):min(width, x1+1)]
            ma, mb = masks[i][window], masks[j][window]
            if np.count_nonzero(ma & mb) < .02*min(areas[i], areas[j]) or _contains_part(a, b, lab) or _contains_part(b, a, lab):
                continue
            hidden.append((j, i) if _in_front(a, b, ma, mb, grad[window], lab) else (i, j))
    for back, front in hidden:
        kept[back]['mask'] = kept[back]['mask'] & ~masks[front]
        kept[back].setdefault('occludedBy', []).append(kept[front]['id'])
    # Topological order (back first); a cycle is broken by sending the larger object back.
    index = {c['id']: n for n, c in enumerate(kept)}
    below = [set() for _ in kept]
    for n, c in enumerate(kept):
        for value in c.get('occludedBy', []):
            if value in index:
                below[index[value]].add(n)
    order, remaining = [], set(range(len(kept)))
    while remaining:
        ready = [n for n in remaining if not below[n] & remaining] or remaining
        n = min(ready, key=lambda k: (-areas[k], kept[k]['_index']))
        order.append(n); remaining.remove(n)
    return {'pairs': len(hidden), 'order': [kept[n]['id'] for n in order]}


def consolidate_candidates(candidates,rgb,max_items=None):
    """Compare globally so an early leg cannot displace a later complete character."""
    lab = cv2.cvtColor(rgb,cv2.COLOR_RGB2LAB).astype(np.float32)
    work=[]
    for index,candidate in enumerate(candidates):
        mask,meta=assemble_graphic(rgb,candidate['mask'],lab)
        work.append({**candidate,'mask':mask,'seedMask':candidate['mask'],'refinement':meta,'_index':index,'_area':int(np.count_nonzero(mask)),
                     '_small':cv2.resize(mask.astype(np.uint8),(192,192),interpolation=cv2.INTER_NEAREST).astype(bool)})
    work.sort(key=lambda c:(-c['_area'],-c.get('scores',{}).get('predictedIoU',0)))
    kept=[];stats={'suppressedParts':0,'duplicates':0,'multipartGraphics':0,'redundantGroups':0}
    representatives=[]
    for item in work:
        for index,previous in enumerate(representatives):
            a,b=item['_small'],previous['_small']
            intersection=np.count_nonzero(a & b)
            iou=intersection/max(1,np.count_nonzero(a | b))
            coverage=intersection/max(1,min(np.count_nonzero(a),np.count_nonzero(b)))
            ratio=min(item['_area'],previous['_area'])/max(1,max(item['_area'],previous['_area']))
            if iou<=.82 and not (coverage>.97 and ratio>.85):
                continue
            ax0,ay0,ax1,ay1=_bbox(item['mask']);bx0,by0,bx1,by1=_bbox(previous['mask'])
            same_extent=(min(ax1-ax0,bx1-bx0)/max(1,max(ax1-ax0,bx1-bx0))>.93 and
                         min(ay1-ay0,by1-by0)/max(1,max(ay1-ay0,by1-by0))>.93)
            qa=item.get('scores',{}).get('predictedIoU',0)
            qb=previous.get('scores',{}).get('predictedIoU',0)
            # Completeness is useful when the extent really grows. For nearly
            # identical extents, extra background pixels are not extra anatomy.
            if (same_extent and qa>qb) or (not same_extent and qa>qb+.08):
                representatives[index]=item
            stats['duplicates']+=1
            break
        else:
            representatives.append(item)
    work=sorted(representatives,key=lambda c:-c['_area'])
    for index, item in enumerate(work):
        if _redundant_group(item, work[:index]+work[index+1:], lab):
            stats['redundantGroups']+=1
            continue
        if any(_contains_part(parent, item, lab) for parent in kept):
            stats['suppressedParts']+=1
        else:
            kept.append(item)
    kept.sort(key=lambda c:c['_index'])
    if max_items is not None and len(kept) > max_items:
        stats['truncatedRegions'] = len(kept) - max_items
        kept = kept[:max_items]
    # A verified multipart overlay is separate source content. Do not leave it in
    # the underlying composite, and do not synthesize the pixels it hides.
    graphics=[c for c in kept if c['refinement']['multipart']]
    for parent in kept:
        if parent['refinement']['multipart']:
            continue
        for graphic in graphics:
            overlap=np.count_nonzero(parent['mask'] & graphic['mask'])
            if overlap > graphic['_area']*.15 and graphic['_area'] < parent['_area']*.65:
                parent['mask']=parent['mask'] & ~graphic['mask']
                parent.setdefault('occludedBy',[]).append(graphic['id'])
    stats['multipartGraphics']=len(graphics)
    resolved=resolve_overlaps(kept,lab)
    stats['overlapPairs']=resolved['pairs']
    # A back object carved below the proposal minimum is a sliver, not a layer worth exporting.
    # One that hides another object stays: its pixels were already carved from the object below.
    fronts={value for c in kept for value in c.get('occludedBy',[])}
    slivers={c['id'] for c in kept if c.get('occludedBy') and c['id'] not in fronts and np.count_nonzero(c['mask'])<c['mask'].size*MIN_REGION_FRACTION}
    stats['carvedSlivers']=len(slivers)
    kept=[c for c in kept if c['id'] not in slivers]
    resolved['order']=[value for value in resolved['order'] if value not in slivers]
    for item in kept:
        for key in ('_small','_area','_index'):
            item.pop(key,None)
    return {'candidates':kept,'stats':stats,'order':resolved['order']}
