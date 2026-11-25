"""Reproducible CPU-only baseline/current text export and compositor QA."""
import importlib.util
import json
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageDraw

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'workers'),str(ROOT/'test/python')]
from text_fixtures_v2 import multicolor_text
from test_text_alpha import styled_text
cv2.setNumThreads(2)
OUT=ROOT/'test-results/layers-text-v2'


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module)
    return module


def composite(rgb,alpha,color):
    return np.rint(rgb.astype(float)*(alpha[:,:,None]/255)+np.array(color)*(1-alpha[:,:,None]/255)).clip(0,255).astype(np.uint8)


def panel(items,path):
    width=max(a.width for _,a in items)
    sheet=Image.new('RGB',(width,sum(a.height+25 for _,a in items)),(230,230,230))
    draw=ImageDraw.Draw(sheet);top=0
    for label,asset in items:
        draw.text((4,top+5),label,fill=(20,20,20));sheet.paste(asset,(0,top+25));top+=asset.height+25
    sheet.save(path)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    report={'controlled':{},'real':{}}
    for version,folder in [('before',ROOT/'temp/layers-text-v2/baseline'),('after',ROOT/'workers')]:
        load('text_effects',folder/'text_effects.py')
        estimator=load('text_alpha',folder/'text_alpha.py').estimate_text_alpha
        exporter=load('qa_masks_'+version,folder/'masks.py').export_text
        case_dir=OUT/version;case_dir.mkdir(exist_ok=True)
        rgb,truth,fg,masks,shadow,poly=multicolor_text()
        dark_rgb,_,dark_outline,dark_shadow,dark_truth=styled_text()
        fixtures=[('multicolor',rgb,truth,fg,poly,masks),('dark-shadow',dark_rgb,dark_truth,np.zeros_like(dark_rgb),np.array([[17,27],[230,27],[230,82],[17,82]]),None)]
        for name,rgb,truth,fg,poly,masks in fixtures:
            result=estimator(rgb,poly)
            alpha=result['alpha'];foreground=result.get('foreground',rgb)
            rgba=np.dstack((foreground,alpha));Image.fromarray(rgba).save(case_dir/f'{name}.png')
            Image.fromarray(rgb).save(OUT/f'{name}-input.png')
            if name=='multicolor':soft=(truth>.12)&(truth<.8)
            else:soft=(dark_shadow>.12)&(dark_shadow<.55)&(dark_outline==0)
            active=soft&(alpha>20)
            metrics={'softAlphaRecall':round(float(np.mean(alpha[soft]>20)),4),
                     'softForegroundMAE':round(float(np.mean(np.abs(foreground[active].astype(float)-fg[active]))),3) if active.any() else None,
                     'softAlphaMAE':round(float(np.mean(np.abs(alpha[soft]/255-truth[soft]))),4),
                     'opaqueRGBChanged':int(np.count_nonzero(np.any(foreground[alpha==255]!=rgb[alpha==255],axis=1)))}
            metrics['opaqueLayerRecall']=round(float(np.mean(alpha[truth>.999]>250)),4)
            if masks is not None:
                metrics['outlineRecall']=[round(float(np.mean(alpha[rim]>220)),4) for rim in [(masks[0]>.98)&(masks[1]<.01),(masks[1]>.98)&(masks[2]<.01)]]
            items=[('Flattened input',Image.fromarray(rgb))]
            for label,color in [('dark',(20,20,20)),('light',(245,245,245))]:
                actual=composite(foreground,alpha,color)
                expected=np.rint(fg*truth[:,:,None]+np.array(color)*(1-truth[:,:,None])).clip(0,255).astype(np.uint8)
                # For the dark fixture only the shadow-only region has known black RGB.
                region=truth>.03 if masks is not None else soft
                metrics[label+'CompositeMAE']=round(float(np.mean(np.abs(actual[region].astype(float)-expected[region]))),3)
                items.append((f'{version} on {label}',Image.fromarray(actual)))
                if masks is not None:items.append((f'Ground truth on {label}',Image.fromarray(expected)))
            panel(items,case_dir/f'{name}-comparison.png')
            report['controlled'].setdefault(name,{})[version]=metrics
        for name,path in [('meeting',ROOT/'temp/text-quality/meeting.png'),('interview',ROOT/'temp/text-quality/interview.png'),('red-graphic',ROOT/'temp/image-benchmark/real-shot.png')]:
            source=np.array(Image.open(path).convert('RGBA'))
            polygons=json.loads((ROOT/f'temp/text-quality/{name}-polygons.json').read_text())
            target=case_dir/name;target.mkdir(exist_ok=True)
            start=time.perf_counter();elements=[];items=[];changed=0;opaque_changed=0;sources_verified=0
            for i,polygon in enumerate(polygons):
                element=exporter(source,polygon,target,f'text_{i+1:03d}');elements.append(element)
                rgba=np.array(Image.open(target/element['file']).convert('RGBA'))
                left,top,width,height=element['bbox'];original=source[top:top+height,left:left+width]
                assert np.all(rgba[:,:,3]<=original[:,:,3]),'Source alpha ceiling violated'
                if element.get('sourceFile'):
                    assert np.array_equal(np.array(Image.open(target/element['sourceFile'])),original),'Original source crop changed'
                    sources_verified+=1
                if element.get('mask'):
                    assert np.array_equal(np.array(Image.open(target/element['mask'])),rgba[:,:,3]),'Mask/export alpha differ'
                changed+=int(np.count_nonzero(np.any(rgba[:,:,:3]!=original[:,:,:3],axis=2)))
                opaque_changed+=int(np.count_nonzero(np.any(rgba[:,:,:3][rgba[:,:,3]==255]!=original[:,:,:3][rgba[:,:,3]==255],axis=1)))
                for label,color in [('dark',(20,20,20)),('light',(245,245,245))]:
                    asset=Image.fromarray(composite(rgba[:,:,:3],rgba[:,:,3],color));asset.thumbnail((1250,190))
                    items.append((f'{version} {element["id"]} on {label}',asset))
            elapsed=round((time.perf_counter()-start)*1000)
            panel(items,target/'comparison.png')
            (target/'result.json').write_text(json.dumps(elements,ensure_ascii=False,indent=2),encoding='utf8')
            report['real'].setdefault(name,{})[version]={'exportMs':elapsed,'count':len(elements),'masks':sum(e['outputKind']=='mask' for e in elements),'changedRGBPixels':changed,'opaqueRGBChanged':opaque_changed,'correctedElements':sum(not e['sourcePixelsOnly'] for e in elements),'originalSourcesVerified':sources_verified}
    (OUT/'metrics.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
