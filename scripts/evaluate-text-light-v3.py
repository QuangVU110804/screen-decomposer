"""CPU text-only before/after QA on identical real OCR polygons and layered controls."""
import importlib.util
import json
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'workers'),str(ROOT/'test/python')]
from text_fixtures_v2 import multicolor_text
from text_fixtures_v3 import blurred_thin_text,shadow_on_texture
cv2.setNumThreads(2)
OUT=ROOT/'test-results/text-light-v3'


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module


def composite(rgba,color):
    a=rgba[:,:,3:4]/255
    return np.rint(rgba[:,:,:3]*a+np.array(color)*(1-a)).clip(0,255).astype(np.uint8)


def alpha_at(element,rgba,point):
    x,y,w,h=element['bbox'];px,py=point
    return int(rgba[py-y,px-x,3]) if x<=px<x+w and y<=py<y+h else 0


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    landmarks=json.loads((ROOT/'test/fixtures/quality/thin-text-landmarks.json').read_text())
    report={'controlled':{},'real':{}}
    thin=blurred_thin_text();nuisance=shadow_on_texture((40,78,55,90));multi=multicolor_text()
    controls=[('thin',*thin,None),('nuisance',*nuisance[:3],nuisance[4],nuisance[3]),
              ('multicolor',multi[0],multi[1],multi[2],multi[5],None)]
    for version,folder in [('before',ROOT/'temp/text-light-v3/baseline'),('after',ROOT/'workers')]:
        load('text_effects',folder/'text_effects.py');estimator=load('text_alpha',folder/'text_alpha.py').estimate_text_alpha
        exporter=load('qa_export_'+version,folder/'masks.py').export_text
        target=OUT/version;target.mkdir(exist_ok=True)
        for name,rgb,truth,fg,poly,patch in controls:
            result=estimator(rgb,poly)
            if result is None:
                report['controlled'].setdefault(name,{})[version]={'kind':'crop'}
                Image.fromarray(rgb).save(target/(name+'.png'));continue
            alpha=result['alpha'];foreground=result.get('foreground',rgb);rgba=np.dstack((foreground,alpha))
            Image.fromarray(rgba).save(target/(name+'.png'))
            metric={'kind':'mask','strokeRecall':round(float(np.mean(alpha[truth>.32]>60)),4),
                    'softRecall':round(float(np.mean(alpha[(truth>.12)&(truth<.55)]>12)),4),
                    'opaqueRGBChanged':int(np.count_nonzero(np.any(foreground[alpha==255]!=rgb[alpha==255],axis=1)))}
            if patch is not None:metric['nuisanceAlphaExcess']=round(float(np.mean(np.maximum(0,alpha[patch]/255-truth[patch]))),4)
            for label,bg in [('light',(245,245,245)),('dark',(20,20,20))]:
                expected=fg*truth[:,:,None]+np.array(bg)*(1-truth[:,:,None]);actual=composite(rgba,bg)
                region=(truth>.03) if patch is None else patch
                metric[label+'CompositeMAE']=round(float(np.mean(np.abs(actual[region]-expected[region]))),3)
            report['controlled'].setdefault(name,{})[version]=metric
        for case,path in [('interview',ROOT/'temp/text-quality/interview.png'),('meeting',ROOT/'temp/text-quality/meeting.png'),('red-graphic',ROOT/'temp/image-benchmark/real-shot.png')]:
            source=np.array(Image.open(path).convert('RGBA'));polygons=json.loads((ROOT/f'temp/text-quality/{case}-polygons.json').read_text())
            directory=target/case;directory.mkdir(exist_ok=True);elements=[];start=time.perf_counter();opaque_changed=0;source_checked=0
            for index,p in enumerate(polygons):
                e=exporter(source,p,directory,f'text_{index+1:03d}');elements.append(e)
                rgba=np.array(Image.open(directory/e['file']).convert('RGBA'));x,y,w,h=e['bbox'];original=source[y:y+h,x:x+w]
                assert np.all(rgba[:,:,3]<=original[:,:,3])
                opaque_changed+=int(np.count_nonzero(np.any(rgba[:,:,:3][rgba[:,:,3]==255]!=original[:,:,:3][rgba[:,:,3]==255],axis=1)))
                if e.get('sourceFile'):
                    assert np.array_equal(np.array(Image.open(directory/e['sourceFile'])),original);source_checked+=1
                if e.get('mask'):assert np.array_equal(np.array(Image.open(directory/e['mask'])),rgba[:,:,3])
                if case=='interview' and e['id']==landmarks['element']:
                    report.setdefault('landmarks',{})[version]={'strokeAlpha':[alpha_at(e,rgba,p) for p in landmarks['strokePoints']],
                        'negativeAlpha':[alpha_at(e,rgba,p) for p in landmarks['negativePoints']]}
            (directory/'result.json').write_text(json.dumps(elements,ensure_ascii=False,indent=2),encoding='utf8')
            report['real'].setdefault(case,{})[version]={'exportMs':round((time.perf_counter()-start)*1000),'masks':sum(e['outputKind']=='mask' for e in elements),
                'count':len(elements),'opaqueRGBChanged':opaque_changed,'sourceCropsVerified':source_checked}
    (OUT/'metrics.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    observed=report['landmarks']['after']
    assert all(a>=landmarks['minimumStrokeAlpha'] for a in observed['strokeAlpha']),observed
    assert all(a<=landmarks['maximumNegativeAlpha'] for a in observed['negativeAlpha']),observed
    font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',20);small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',14)
    canvas=Image.new('RGB',(1240,800),(22,24,29));d=ImageDraw.Draw(canvas)
    rows=[('interview','text_003','Nét mảnh: trong một ngách hẹp'),('interview','text_001','Viền và bóng chữ vàng trên nền sáng'),
          ('meeting','text_002','Bóng phụ đề trắng trên nền sáng'),('interview','text_006','Dấu và nét chữ ở dòng trên')]
    for row,(case,key,label) in enumerate(rows):
        d.text((16,row*198+8),label,font=font,fill='white')
        for col,version in enumerate(['before','after']):
            left=16+col*612;d.text((left,row*198+36),'Trước' if version=='before' else 'Sau',font=small,fill=(183,189,200))
            rgba=np.array(Image.open(OUT/version/case/(key+'.png')).convert('RGBA'))
            asset=Image.fromarray(composite(rgba,(245,245,245)));asset.thumbnail((584,120),Image.Resampling.LANCZOS)
            board=Image.new('RGB',(596,130),(245,245,245));board.paste(asset,((596-asset.width)//2,(130-asset.height)//2));canvas.paste(board,(left,row*198+59))
    canvas.save(OUT/'real-before-after-light.png')
    # Thin white lettering also needs a contrasting view to judge stroke continuity.
    canvas=Image.new('RGB',(1240,230),(22,24,29));d=ImageDraw.Draw(canvas)
    for col,version in enumerate(['before','after']):
        left=16+col*612;d.text((left,10),'Nét mảnh · '+('trước' if version=='before' else 'sau'),font=font,fill='white')
        rgba=np.array(Image.open(OUT/version/'interview/text_003.png').convert('RGBA'))
        asset=Image.fromarray(composite(rgba,(20,20,20)));asset.thumbnail((596,160));canvas.paste(asset,(left,52))
    canvas.save(OUT/'thin-before-after-dark.png')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
