"""Render QA boards from real native exports; never modifies the exported assets."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'test-results/layers-text-v2'
font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',19)
small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',14)


def checker(size):
    board=Image.new('RGB',size,(40,43,50));d=ImageDraw.Draw(board)
    for y in range(0,size[1],14):
        for x in range(0,size[0],14):
            if (x//14+y//14)%2:d.rectangle((x,y,x+13,y+13),fill=(52,55,63))
    return board


canvas=Image.new('RGB',(1032,580),(20,22,27));d=ImageDraw.Draw(canvas)
samples=[('Chồng A lên B',out/'overlap/layout-after.png','scene'),
         ('B bị thiếu mask (mô phỏng)',out/'overlap/B-erased.png','layer'),
         ('B đầy đủ từ ảnh gốc nhập vào',out/'overlap/B-final.png','layer')]
for i,(label,path,kind) in enumerate(samples):
    x=16+i*344;d.text((x,18),label,font=font,fill='white');board=checker((328,498))
    with Image.open(path) as im:
        im=im.convert('RGBA')
        if kind=='scene':im=im.crop((280,80,650,575))
        im.thumbnail((310,480),Image.Resampling.LANCZOS)
        board.paste(im,((328-im.width)//2,(498-im.height)//2),im)
    canvas.paste(board,(x,54))
d.text((16,558),'Mẫu chồng lớp dùng asset thật · B sau trùng RGBA nguồn · A giữ nguyên · Không tạo bù phần bị che',font=small,fill=(184,188,199))
canvas.save(out/'overlap-comparison.png')

canvas=Image.new('RGB',(1160,570),(20,22,27));d=ImageDraw.Draw(canvas)
for row,(case,key,label,bg) in enumerate([
    ('meeting','text_002','Bóng chữ trên nền tối',(18,18,20)),
    ('meeting','text_002','Cùng PNG ghép lên nền sáng',(238,238,238)),
    ('interview','text_001','Chữ vàng và viền đen',(18,18,20))]):
    d.text((18,row*184+8),label,font=font,fill='white')
    for col,(generation,title) in enumerate([('before','Trước'),('after','Sau')]):
        left=18+col*570;d.text((left,row*184+36),title,font=small,fill=(184,188,199))
        board=Image.new('RGB',(552,118),bg)
        with Image.open(out/generation/case/(key+'.png')) as im:
            im=im.convert('RGBA');im.thumbnail((536,104),Image.Resampling.LANCZOS)
            board.paste(im,((552-im.width)//2,(118-im.height)//2),im)
        canvas.paste(board,(left,row*184+58))
canvas.save(out/'text-real-comparison.png')
print(out/'overlap-comparison.png');print(out/'text-real-comparison.png')
