"""Reprocess existing model proposals without another model inference (diagnostic)."""
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'workers'))
from regions import consolidate_candidates
from masks import export_mask
source=Path(sys.argv[1]);previous=Path(sys.argv[2]);out=Path(sys.argv[3]);out.mkdir(parents=True,exist_ok=True)
rgba=np.array(Image.open(source).convert('RGBA'));rgb=rgba[:,:,:3]
data=json.loads((previous/'result.json').read_text(encoding='utf-8'))
candidates=[]
for element in data['elements']:
    if element['type']=='text-region' or not element.get('mask'):continue
    left,top,width,height=element['bbox']
    mask=np.zeros(rgba.shape[:2],bool)
    piece=np.array(Image.open(previous/element['mask']).resize((width,height)))>127
    mask[top:top+height,left:left+width]=piece
    candidates.append({'id':element['id'],'mask':mask,'scores':element.get('scores',{})})
result=consolidate_candidates(candidates,rgb)
elements=[]
for candidate in result['candidates']:
    element=export_mask(rgba,candidate['mask'],out,candidate['id'])
    element['refinement']=candidate['refinement'];elements.append(element)
(out/'result.json').write_text(json.dumps({'elements':elements,'postprocess':result['stats']}),encoding='utf-8')
print(json.dumps({'stats':result['stats'],'elements':[{key:e[key] for key in ['id','bbox','refinement']} for e in elements]},indent=2))
