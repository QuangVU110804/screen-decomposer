"""Render actual exported PNG alpha on the same checkerboard/scale for QA."""
import json
from pathlib import Path
import sys
from PIL import Image,ImageDraw,ImageFont

root=Path(__file__).resolve().parents[1]
before,after,out=map(Path,sys.argv[1:4]);out.mkdir(parents=True,exist_ok=True)
landmarks=json.loads((root/'test/fixtures/quality/reference-landmarks.json').read_text())
old=json.loads((before/'result.json').read_text(encoding='utf8'))['elements']
new=json.loads((after/'result.json').read_text(encoding='utf8'))['elements']
sun=next(e for e in new if e.get('refinement',{}).get('multipart'))
cx,cy=landmarks['sunCore']
old_sun=min((e for e in old if e['bbox'][0]<=cx<e['bbox'][0]+e['bbox'][2] and e['bbox'][1]<=cy<e['bbox'][1]+e['bbox'][3]),key=lambda e:e['bbox'][2]*e['bbox'][3])
x,y,w,h=sun['bbox'];world=(x-12,y-12,w+24,h+24)
canvas=Image.new('RGB',(900,452),(20,22,27));draw=ImageDraw.Draw(canvas)
font_file=Path('C:/Windows/Fonts/segoeui.ttf')
font=ImageFont.truetype(str(font_file),20) if font_file.exists() else ImageFont.load_default()
small=ImageFont.truetype(str(font_file),14) if font_file.exists() else font
for directory,element,left,title in [(before,old_sun,22,'Trước: chỉ vùng tròn'),(after,sun,462,'Sau: thân + 11 tia')]:
    board=Image.new('RGB',(416,356),(39,41,48));d=ImageDraw.Draw(board)
    for yy in range(0,356,16):
        for xx in range(0,416,16):
            if (xx//16+yy//16)%2:d.rectangle((xx,yy,xx+15,yy+15),fill=(49,51,59))
    layer=Image.new('RGBA',(world[2],world[3]),(0,0,0,0))
    with Image.open(directory/element['file']) as image:
        layer.alpha_composite(image.convert('RGBA'),(element['bbox'][0]-world[0],element['bbox'][1]-world[1]))
    layer.thumbnail((396,336),Image.Resampling.LANCZOS)
    board.paste(layer,((416-layer.width)//2,(356-layer.height)//2),layer)
    canvas.paste(board,(left,58));draw.text((left,18),title,font=font,fill=(239,239,244))
draw.text((22,426),'PNG alpha từ pixel nguồn · Khoảng trống giữa các tia được giữ trong suốt',font=small,fill=(177,182,194))
canvas.save(out/'sun-comparison.png')
for name,element in [('sun-complete',sun),('whole-character',min((e for e in new if e['type']!='graphic'),key=lambda e:e['bbox'][0]))]:
    with Image.open(after/element['file']) as image:image.save(out/(name+'.png'))
print(out/'sun-comparison.png')
