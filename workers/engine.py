"""CPU-only image worker. JSONL protocol; all model/library diagnostics go to stderr."""
import contextlib
import gc
import hashlib
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
ROOT = Path(__file__).resolve().parents[1]


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def doctor(model_dir):
    model_dir = Path(model_dir)
    packages = {name: importlib.util.find_spec(name) is not None for name in ('torch', 'torchvision', 'timm', 'mobile_sam', 'rapidocr_onnxruntime', 'onnxruntime', 'numpy', 'cv2', 'PIL')}
    manifest_path = model_dir / 'manifest.json'
    valid = {}
    fingerprint = ''
    if manifest_path.exists():
        manifest_data = manifest_path.read_bytes()
        code = b''.join(p.name.encode()+p.read_bytes() for p in sorted((ROOT/'workers').glob('*.py')))
        versions = {}
        for name in ('torch', 'torchvision', 'timm', 'rapidocr-onnxruntime', 'onnxruntime', 'numpy', 'Pillow'):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = None
        fingerprint = hashlib.sha256(manifest_data + code + json.dumps(versions, sort_keys=True).encode()).hexdigest()
        for model in json.loads(manifest_data).get('files', []):
            file = model_dir / model['file']
            valid[model['file']] = file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest() == model['sha256']
    segmentation = all(packages[k] for k in ('torch', 'torchvision', 'timm', 'mobile_sam', 'numpy', 'cv2', 'PIL')) and valid.get('mobile_sam.pt', False)
    text = all(packages[k] for k in ('rapidocr_onnxruntime', 'onnxruntime', 'numpy', 'cv2', 'PIL')) and valid.get('rapidocr/det.onnx', False)
    return {'ready': bool(segmentation and text), 'segmentation': bool(segmentation), 'text': bool(text),
            'packages': packages, 'models': valid, 'fingerprint': fingerprint, 'device': 'cpu',
            'message': 'Engine CPU sẵn sàng' if segmentation and text else 'Thiếu package hoặc model. Chạy npm run setup:local.'}


def no_network(*args, **kwargs):
    raise RuntimeError('Network access is disabled during local inference')


def run(request):
    import socket
    socket.create_connection = no_network
    socket.socket.connect = no_network
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        from PIL import Image
        from masks import MaskFilter, append_warning, artifact_names, export_mask, export_text, scale_text_boxes, soft_box, upsample_logits
        from regions import consolidate_candidates, drop_tile_edge_masks, refine_graphic_crop, refine_survivors, tile_boxes, uncovered_points
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        cv2.setNumThreads(2)
    source_path, output = Path(request['source']), Path(request['output'])
    output.mkdir(parents=True, exist_ok=True)
    model_dir = Path(request.get('modelDir', ROOT / 'models'))
    state = doctor(model_dir)
    if not state['segmentation'] and not state['text']:
        raise RuntimeError(state['message'])
    preset = {'fast': (768, 8), 'balanced': (1024, 12)}[request.get('preset', 'fast')]
    started = time.perf_counter()
    with Image.open(source_path) as image:
        source = np.asarray(image.convert('RGBA'))
    # Composite transparent input over white for inference; export still uses original alpha.
    # In place: the same float32 operations, without four full-frame temporaries (~1 GiB at 24 MP).
    alpha = source[:, :, 3:4].astype(np.float32)
    alpha /= 255
    rgb = source[:, :, :3].astype(np.float32)
    rgb *= alpha
    np.subtract(1, alpha, out=alpha)
    alpha *= 255
    rgb += alpha
    del alpha
    rgb = np.rint(rgb, out=rgb).astype(np.uint8)
    elements, warnings, timings, engines = [], [], {}, {}
    postprocess={}
    limit = min(80, int(request.get('maxAssets', 80)))

    def checkpoint():
        value = {'type': 'result', 'elements': elements, 'warnings': warnings, 'timings': timings, 'engines': engines,
                 'engineFingerprint': state['fingerprint'], 'pipelineVersion': 4, 'postprocess':postprocess}
        temporary = output / 'result.tmp'
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        temporary.replace(output / 'result.json')
        return value

    emit({'type': 'stage', 'stage': 'text'})
    stage_start = time.perf_counter()
    try:
        if not state['text']:
            raise RuntimeError('OCR local chưa sẵn sàng')
        with contextlib.redirect_stdout(sys.stderr):
            import rapidocr_onnxruntime
            from rapidocr_onnxruntime.ch_ppocr_det import TextDetector
            from rapidocr_onnxruntime.utils import read_yaml
            det_config = read_yaml(Path(rapidocr_onnxruntime.__file__).parent / 'config.yaml')['Det']
            det_config.update(model_path=str(model_dir / 'rapidocr/det.onnx'), intra_op_num_threads=2,
                              inter_op_num_threads=1, limit_type='max', box_thresh=0.65)
            # Only the detector: the full facade loads unused recognition models too.
            ocr = TextDetector(det_config)
            ocr_scale = min(1.0, 960 / max(rgb.shape[:2]))
            ocr_image = cv2.resize(rgb, (max(1, round(rgb.shape[1]*ocr_scale)), max(1, round(rgb.shape[0]*ocr_scale))), interpolation=cv2.INTER_AREA)
            boxes, _ = ocr(cv2.cvtColor(ocr_image, cv2.COLOR_RGB2BGR))
            boxes = scale_text_boxes(boxes, ocr_image.shape[:2], source.shape[:2])
        if boxes is not None:
            for polygon in boxes:
                if len(elements) >= min(limit, 30):
                    warnings.append('Giới hạn số vùng chữ; kết quả có thể chưa đầy đủ.')
                    break
                item = export_text(source, polygon, output, f'text_{len(elements)+1:03d}')
                if item:
                    elements.append(item)
        del ocr, ocr_image
        gc.collect()
        engines['text'] = {'ok': True, 'provider': 'rapidocr-onnxruntime', 'version': importlib.metadata.version('rapidocr-onnxruntime'), 'recognition': False}
    except Exception as error:
        warnings.append(f'OCR: {error}')
        engines['text'] = {'ok': False}
    timings['textMs'] = round((time.perf_counter() - stage_start) * 1000)
    checkpoint()

    emit({'type': 'stage', 'stage': 'masks'})
    stage_start = time.perf_counter()
    engines['segmentation'] = {'ok': False, 'incomplete': True, 'provider': 'MobileSAM'}
    try:
        if not state['segmentation']:
            raise RuntimeError('MobileSAM local chưa sẵn sàng')
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from mobile_sam import sam_model_registry, SamPredictor
            torch.set_num_threads(2)
            torch.set_num_interop_threads(1)
            model = sam_model_registry['vit_t'](checkpoint=str(model_dir / 'mobile_sam.pt'))
            model.to(device='cpu').eval()
            predictor = SamPredictor(model)
        h, w = rgb.shape[:2]
        scale = min(1.0, preset[0] / max(h, w))
        proxy = cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else rgb
        load_finished = time.perf_counter()
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            predictor.set_image(proxy)
        # Tiles replace the embedding; keep the proxy one for refinement instead of re-encoding.
        proxy_embedding = (predictor.features, predictor.original_size, predictor.input_size)
        timings['embeddingMs'] = round((time.perf_counter() - load_finished) * 1000)
        def grid_points(shape, count):
            locations = np.linspace(0.5 / count, 1 - 0.5 / count, count)
            return np.array([(x * shape[1], y * shape[0]) for y in locations for x in locations], dtype=np.float32)

        # Cover the whole image, starting with compact objects the grid may miss.
        grid = preset[1]
        points = grid_points(proxy.shape, grid)
        extra_points = uncovered_points(proxy, points)
        if extra_points:
            points = np.vstack([np.asarray(extra_points, dtype=np.float32), points])
        # Provisional duplicates must not consume the final export allowance or
        # stop the scan before later parts of a crowded image are visited.
        text_count = len(elements)
        proposal_limit = 2 * (limit - text_count)
        # Keep a usable interruption checkpoint without writing every provisional mask.
        checkpoint_limit = min(limit, text_count + 16)
        filt = MaskFilter(max_items=proposal_limit)
        candidates=[]

        def scan(image_shape, points, project=None):
            """Prompt points on the current embedding; `project` maps a tile mask and point onto the proxy."""
            prompted = 0
            for offset in range(0, len(points), 8):
                if len(candidates) >= proposal_limit:
                    break
                batch = points[offset:offset+8]
                prompted += len(batch)
                transformed = predictor.transform.apply_coords(batch, image_shape)
                coords = torch.as_tensor(transformed, dtype=torch.float32)[:, None, :]
                labels = torch.ones((len(batch), 1), dtype=torch.int64)
                with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                    masks, scores, low_res = predictor.predict_torch(point_coords=coords, point_labels=labels, multimask_output=True, return_logits=False)
                masks_np, scores_np = masks.cpu().numpy().reshape(-1, *image_shape), scores.cpu().numpy().reshape(-1)
                logits = low_res.reshape(-1, 256, 256)
                stability_np = ((logits > 1.0).sum(dim=(1, 2)) / (logits > -1.0).sum(dim=(1, 2)).clamp(min=1)).cpu().numpy()
                # masks are SAM's logits > mask_threshold (0.0); keep the 256x256 logits for soft alpha.
                logits_np = logits.cpu().numpy()
                # SAM predicted IoU is a model score, not editor acceptance.
                order = np.argsort(-scores_np)
                for index in order:
                    score = float(scores_np[index])
                    if score < 0.82 or float(stability_np[index]) < 0.90:
                        continue
                    # Three masks per prompt point.
                    mask, point, low = masks_np[index], batch[index // 3], logits_np[index].astype(np.float16)
                    if project:
                        mask, point = project(mask, point)
                        low = None  # tile logits belong to another embedding; prompt refinement replaces them
                        if mask is None:
                            continue
                    if not filt.accept(mask,score):
                        continue
                    proposal_id = f'region_{len(candidates)+1:03d}'
                    quality = {'predictedIoU': round(score, 4), 'stability': round(float(stability_np[index]), 4)}
                    candidates.append({'id': proposal_id, 'mask': mask.copy(), 'scores': quality, 'lowRes': low,
                                       'point': (float(point[0]), float(point[1])), 'fromTile': project is not None})
                    if len(elements) < checkpoint_limit:
                        item = export_mask(source, mask, output, proposal_id)
                        if item:
                            item['scores'] = quality
                            elements.append(item)
                del masks, scores, low_res, logits, logits_np, masks_np, scores_np, stability_np
                if project is None:  # tile progress is reported per tile
                    emit({'type': 'progress', 'completed': min(offset+8, len(points)), 'total': len(points), 'count': text_count + len(candidates)})
                checkpoint()
            return prompted

        scan(proxy.shape[:2], points)
        # Small objects get more pixels from source-resolution tiles (balanced only).
        tiles = tile_boxes(proxy.shape, rgb.shape) if request.get('preset') == 'balanced' else []
        tile_prompts, tiles_scanned = 0, False
        if tiles and len(candidates) < proposal_limit:
            emit({'type': 'stage', 'stage': 'tiles'})
            sx, sy = proxy.shape[1] / w, proxy.shape[0] / h
            for number, (x0, y0, x1, y1) in enumerate(tiles):
                if len(candidates) >= proposal_limit:
                    break
                crop = rgb[y0:y1, x0:x1]
                tile_scale = min(1.0, 1024 / max(crop.shape[:2]))
                tile = cv2.resize(crop, (max(1, round(crop.shape[1]*tile_scale)), max(1, round(crop.shape[0]*tile_scale))), interpolation=cv2.INTER_AREA) if tile_scale < 1 else crop
                left, top, right, bottom = round(x0*sx), round(y0*sy), round(x1*sx), round(y1*sy)

                def project(mask, point):
                    if drop_tile_edge_masks(mask, (x0, y0, x1, y1), rgb.shape):
                        return None, None
                    full = np.zeros(proxy.shape[:2], bool)
                    full[top:bottom, left:right] = cv2.resize(mask.astype(np.float32), (right-left, bottom-top), interpolation=cv2.INTER_AREA) > .5
                    return full, ((x0 + point[0]/tile_scale) * sx, (y0 + point[1]/tile_scale) * sy)

                with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                    predictor.set_image(tile)
                tiles_scanned = True
                tile_prompts += scan(tile.shape[:2], grid_points(tile.shape, 4), project)  # 4x4: 6x6 cost +75% on anime-shot
                emit({'type': 'progress', 'completed': number+1, 'total': len(tiles), 'count': text_count + len(candidates)})
                checkpoint()
        if proposal_limit and len(candidates) >= proposal_limit:
            warnings.append('Đã chạm giới hạn đề xuất vùng ảnh; kết quả có thể chưa đầy đủ.')
        emit({'type':'stage','stage':'refining'})
        refinement_start=time.perf_counter()
        if tiles_scanned:
            predictor.features, predictor.original_size, predictor.input_size = proxy_embedding
            predictor.is_image_set = True

        def predict(points, boxes, mask_inputs):
            coords = torch.as_tensor(predictor.transform.apply_coords(np.array(points, np.float32), proxy.shape[:2]), dtype=torch.float32)[:, None, :]
            box_tensor = torch.as_tensor(predictor.transform.apply_boxes(np.array(boxes, np.float32), proxy.shape[:2]), dtype=torch.float32)
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                masks, scores, low_res = predictor.predict_torch(point_coords=coords, point_labels=torch.ones((len(points), 1), dtype=torch.int64), boxes=box_tensor,
                                                                 mask_input=None if mask_inputs is None else torch.as_tensor(mask_inputs), multimask_output=False)
            return [(mask[0], float(score[0]), low[0].astype(np.float16)) for mask, score, low in zip(masks.numpy(), scores.numpy(), low_res.numpy())]

        # A re-prompt costs ~0.1-0.2 s on CPU, so only proposals that survive a first selection are
        # refined; the final consolidation runs after refinement because it carves overlaps.
        selected = consolidate_candidates(candidates,proxy,max_items=limit-text_count)
        refined = refine_survivors(predict, candidates, selected['candidates'])
        # SAM, the inference copy and the proposal pool are no longer needed: free them before
        # full-resolution exports (a 158-proposal pool at proxy 1024 holds ~110 MiB of masks).
        proposal_count, pool_stats = len(candidates), selected['stats']
        del rgb, predict, predictor, model, proxy_embedding, candidates, selected
        consolidated=consolidate_candidates(refined,proxy,max_items=limit-text_count)
        del refined
        gc.collect()
        # Pool decisions come from the first pass; add whatever the refined masks merged further.
        postprocess=dict(pool_stats)
        for key in ('suppressedParts', 'duplicates', 'redundantGroups', 'carvedSlivers'):
            postprocess[key] += consolidated['stats'][key]
        postprocess['multipartGraphics']=consolidated['stats']['multipartGraphics']
        postprocess['overlapPairs']=consolidated['stats']['overlapPairs']
        if postprocess.get('truncatedRegions'):
            warnings.append(f'Chỉ giữ tối đa {limit} vùng sau khi lọc.')
        postprocess['extraPrompts'] = len(extra_points)
        postprocess['proposals'] = proposal_count
        postprocess['tilePrompts'] = tile_prompts
        postprocess['tileRegions'] = sum(candidate['fromTile'] for candidate in consolidated['candidates'])
        postprocess['promptRefined'] = sum(candidate['promptRefined'] for candidate in consolidated['candidates'])
        postprocess['nativeEdgeRegions'] = 0
        # New IDs make the final bundle a separate generation. Until its checkpoint
        # is committed, interruption still has a complete earlier generation.
        next_index=proposal_count+1
        id_map={candidate['id']:f'region_{next_index+i:03d}' for i,candidate in enumerate(consolidated['candidates'])}
        final=[element for element in elements if element['type']=='text-region']
        details={}
        for candidate in consolidated['candidates']:
            if candidate['refinement']['multipart']:
                details[candidate['id']]=refine_graphic_crop(source,candidate['seedMask'],candidate['mask'])
        def export_region(candidate, excludes):
            if candidate['id'] in details:
                crop,source_mask,(left,top),detail_meta=details[candidate['id']]
                item=export_mask(crop,source_mask,output,id_map[candidate['id']])
                if item:
                    item['bbox'][0]+=left;item['bbox'][1]+=top
                return item
            low_res=candidate.pop('lowRes',None)
            if low_res is None:
                return export_mask(source,candidate['mask'],output,id_map[candidate['id']],exclusions=excludes,refine_edges=True)
            # Passed without a local reference so export_mask can free the logits before colour estimation.
            return export_mask(source,candidate['mask'],output,id_map[candidate['id']],exclusions=excludes,
                               logits=upsample_logits(low_res,proxy.shape[:2],source.shape[:2],soft_box(candidate['mask'],source.shape[:2])))

        for candidate in consolidated['candidates']:
            excludes=[(details[value][2],details[value][1]) for value in candidate.get('occludedBy',[]) if value in details]
            # One region must not fail the whole segmentation: fall back to the hard source edge, then skip.
            try:
                item=export_region(candidate,excludes)
            except Exception as error:
                try:
                    item=export_mask(source,candidate['mask'],output,id_map[candidate['id']],exclusions=excludes,refine_edges=True)
                    warnings.append(f'{id_map[candidate["id"]]}: không xuất được biên mềm ({error}); dùng biên cứng.')
                except Exception as fallback_error:
                    item=None
                    warnings.append(f'{id_map[candidate["id"]]}: bỏ qua vùng do lỗi xuất ({fallback_error}).')
            if item is None:
                continue
            item['scores']=candidate['scores']
            postprocess['nativeEdgeRegions'] += int(item.get('refinement', {}).get('sourceEdgeRefined', False))
            item['refinement']={**candidate['refinement'], **item.get('refinement', {})}
            if candidate['id'] in details:
                item['refinement']={**candidate['refinement'],**details[candidate['id']][3]}
            item['refinement']['promptRefined']=candidate['promptRefined']
            if candidate['refinement']['multipart']:
                item['type']='graphic'
                item['label']='Graphic nhiều phần'
                item['edgeWarning']='Đã gom các phần rời theo màu và hình học; kiểm tra chi tiết cùng màu ở gần.'
            if candidate.get('occludedBy'):
                item['occludedBy']=[id_map[value] for value in candidate['occludedBy']]
                # Append: the export warning explains why RGB differs from sourceFile.
                append_warning(item,'Đã loại graphic chồng lên; phần bị che được để trong suốt, không vẽ lại.'
                               if all(value in details for value in candidate['occludedBy']) else
                               'Đã loại phần bị vật thể khác che; vùng bị che để trong suốt, không vẽ lại.')
            final.append(item)
        # Back-to-front image regions, then text regions on top in their detection order.
        rank={id_map[value]:n for n,value in enumerate(consolidated['order'])}
        stacked=sorted(final,key=lambda element:(element['type']=='text-region',rank.get(element['id'],0)))
        for n,element in enumerate(stacked):
            element['layerOrder']=n
        elements[:]=final
        exported = {element['id'] for element in elements}
        for element in elements:
            if element.get('occludedBy'):
                element['occludedBy'] = [value for value in element['occludedBy'] if value in exported]
        checkpoint()
        keep=artifact_names(elements)
        for file in output.glob('region_*'):
            if file.is_file() and file.name not in keep:
                file.unlink()
        timings['refinementMs']=round((time.perf_counter()-refinement_start)*1000)
        engines['segmentation'] = {'ok': True, 'provider': 'MobileSAM', 'revision': 'f706ad9c4eb7f219c00d9050e46328518ffb65d2', 'device': 'cpu', 'grid': grid, 'proxy': list(proxy.shape[:2])}
        del consolidated
        gc.collect()
    except Exception as error:
        warnings.append(f'Segmentation: {error}')
        engines['segmentation'] = {'ok': False}
    timings['masksMs'] = round((time.perf_counter() - stage_start) * 1000)
    timings['totalMs'] = round((time.perf_counter() - started) * 1000)
    try:
        import psutil
        info = psutil.Process().memory_info()
        timings['peakWorkingSetBytes'] = getattr(info, 'peak_wset', info.rss)
    except ImportError:
        pass
    if not any(engine.get('ok') for engine in engines.values()):
        checkpoint()
        raise RuntimeError('; '.join(warnings))
    emit(checkpoint())


if __name__ == '__main__':
    try:
        if '--doctor' in sys.argv:
            emit(doctor(sys.argv[2] if len(sys.argv) > 2 else ROOT / 'models'))
        else:
            run(json.loads(sys.stdin.readline()))
    except Exception as error:
        emit({'type': 'error', 'message': str(error)})
        sys.exit(1)
