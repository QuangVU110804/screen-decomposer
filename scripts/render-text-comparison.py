"""Show actual baseline/current exports on equal source-coordinate canvases."""
import json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'test-results/text-quality'
font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',20)
small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',16)
samples=[('interview','text_001','Chữ vàng có viền đen'),('meeting','text_002','Chữ trắng có bóng trên nền người'),('meeting','text_001','Dòng phụ đề từng còn nguyên nền')]
canvas=Image.new('RGB',(1260,660),(22,24,30));draw=ImageDraw.Draw(canvas)
for row,(case,key,title) in enumerate(samples):
    old_dir=out/'baseline'/case;new_dir=out/'current'/case
    old=json.loads((old_dir/'result.json').read_text(encoding='utf8'))
    new=json.loads((new_dir/'result.json').read_text(encoding='utf8'))
    before=next(e for e in old['elements'] if e['id']==key)
    after=next(e for e in new['elements'] if e['id']==key)
    x,y,w,h=after['bbox']
    draw.text((18,row*220+8),title,font=font,fill='white')
    for col,(directory,element,bg,label) in enumerate([(old_dir,before,(100,100,100),'Trước'),(new_dir,after,(35,38,44),'Sau · nền tối'),(new_dir,after,(238,238,238),'Sau · nền sáng')]):
        layer=Image.new('RGBA',(w,h),(0,0,0,0))
        with Image.open(directory/element['file']) as image:layer.alpha_composite(image.convert('RGBA'),(element['bbox'][0]-x,element['bbox'][1]-y))
        layer.thumbnail((396,134),Image.Resampling.LANCZOS)
        board=Image.new('RGB',(404,146),bg);board.paste(layer,((404-layer.width)//2,(146-layer.height)//2),layer)
        left=18+col*416;top=row*220+64
        canvas.paste(board,(left,top));draw.text((left,row*220+39),label,font=small,fill=(180,186,199))
canvas.save(out/'text-comparison.png')
print(out/'text-comparison.png')
