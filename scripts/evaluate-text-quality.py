"""Re-export identical real OCR polygons for before/after text-alpha QA (CPU only)."""
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'workers'))
cv2.setNumThreads(2)


def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('output',type=Path)
    parser.add_argument('--baseline',type=Path)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    if args.baseline:
        sys.modules['text_alpha']=load_module('text_alpha',args.baseline/'baseline_text_alpha.py')
        exporter=load_module('baseline_masks',args.baseline/'baseline_masks.py').export_text
    else:
        from masks import export_text
        exporter=export_text
    cases=[('red-graphic',ROOT/'temp/image-benchmark/real-shot.png'),
           ('interview',ROOT/'temp/text-quality/interview.png'),('meeting',ROOT/'temp/text-quality/meeting.png')]
    import rapidocr_onnxruntime
    from rapidocr_onnxruntime.ch_ppocr_det import TextDetector
    from rapidocr_onnxruntime.utils import read_yaml
    config=read_yaml(Path(rapidocr_onnxruntime.__file__).parent/'config.yaml')['Det']
    config.update(model_path=str(ROOT/'models/rapidocr/det.onnx'),intra_op_num_threads=2,inter_op_num_threads=1,limit_type='max',box_thresh=.65)
    detector=TextDetector(config);report=[]
    for name,path in cases:
        source=np.array(Image.open(path).convert('RGBA'));rgb=source[:,:,:3]
        case=args.output/name;case.mkdir(exist_ok=True)
        annotations=ROOT/'temp/text-quality'/f'{name}-polygons.json'
        if annotations.exists():polygons=json.loads(annotations.read_text())
        else:
            scale=min(1,960/max(rgb.shape[:2]));small=cv2.resize(rgb,(round(rgb.shape[1]*scale),round(rgb.shape[0]*scale)))
            boxes,_=detector(cv2.cvtColor(small,cv2.COLOR_RGB2BGR))
            polygons=(boxes/np.array([small.shape[1]/rgb.shape[1],small.shape[0]/rgb.shape[0]])).tolist() if boxes is not None else []
            annotations.write_text(json.dumps(polygons),encoding='utf8')
        start=time.perf_counter()
        elements=[exporter(source,p,case,f'text_{i+1:03d}') for i,p in enumerate(polygons)]
        elements=[e for e in elements if e]
        result={'name':name,'source':str(path),'dimensions':[rgb.shape[1],rgb.shape[0]],'exportMs':round((time.perf_counter()-start)*1000),'elements':elements}
        (case/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        report.append({'name':name,'count':len(elements),'masks':sum(e['outputKind']=='mask' for e in elements),'exportMs':result['exportMs']})
        # Each preview is made from the real exported PNG on a checkerboard.
        for e in elements:
            with Image.open(case/e['file']) as asset:
                asset=asset.convert('RGBA');asset.thumbnail((1000,180))
                board=Image.new('RGB',asset.size,(80,80,80));draw=ImageDraw.Draw(board)
                for y in range(0,asset.height,12):
                    for x in range(0,asset.width,12):
                        if (x//12+y//12)%2:draw.rectangle((x,y,x+11,y+11),fill=(125,125,125))
                board.paste(asset,(0,0),asset);board.save(case/f"{e['id']}-preview.png")
    (args.output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
