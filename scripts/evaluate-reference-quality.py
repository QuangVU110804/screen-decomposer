"""Evaluate hand-annotated landmarks against exported source-coordinate alpha."""
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]
landmarks=json.loads((root/'test/fixtures/quality/reference-landmarks.json').read_text())
directory=Path(sys.argv[1])
result=json.loads((directory/'result.json').read_text(encoding='utf-8'))

def alpha_at(element,point):
    left,top,width,height=element['bbox'];x,y=point
    if not left<=x<left+width or not top<=y<top+height:return 0
    with Image.open(directory/element['file']) as im:return int(np.array(im.convert('RGBA'))[y-top,x-left,3])

regions=[e for e in result['elements'] if e['type']!='text-region']
sun=max(regions,key=lambda e:sum(alpha_at(e,p)>128 for p in landmarks['rayCenters']))
body=max(regions,key=lambda e:sum(alpha_at(e,p)>128 for p in landmarks['wholeCharacterPoints']))
report={'elementCount':len(result['elements']),'sunId':sun['id'],'rayCentersKept':sum(alpha_at(sun,p)>128 for p in landmarks['rayCenters']),
        'rayCentersTotal':len(landmarks['rayCenters']),'sunGapsTransparent':all(alpha_at(sun,p)<10 for p in landmarks['transparentSunGaps']),
        'bodyId':body['id'],'wholeCharacterPointsKept':sum(alpha_at(body,p)>128 for p in landmarks['wholeCharacterPoints']),
        'wholeCharacterPointsTotal':len(landmarks['wholeCharacterPoints']),'postprocess':result.get('postprocess'),
        'warnings':result.get('warnings',[])}
print(json.dumps(report,indent=2))
if '--assert' in sys.argv:
    assert report['rayCentersKept']==report['rayCentersTotal'],report
    assert report['sunGapsTransparent'],report
    assert report['wholeCharacterPointsKept']==report['wholeCharacterPointsTotal'],report
