"""Overview sheet of the kit (preview-sheet.png). Run via export.sh (arg: dir with ico16/32/48.png)."""
import os, sys
from PIL import Image, ImageDraw, ImageFont
F=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T=sys.argv[1] if len(sys.argv)>1 else "/tmp"
W,H=2000,2900
im=Image.new("RGB",(W,H),"#0b1020"); d=ImageDraw.Draw(im)
fnt=lambda s: ImageFont.truetype(f"{F}/font/Audiowide-Regular.ttf",s)
LAB="#9aa3b5"
def paste(p,box,fill=None,label=None,scale=0.86):
    x0,y0,x1,y1=box
    if fill: d.rectangle(box,fill=fill)
    a=Image.open(p).convert("RGBA"); bw,bh=(x1-x0)*scale,(y1-y0)*scale
    r=min(bw/a.width,bh/a.height); a=a.resize((max(1,round(a.width*r)),max(1,round(a.height*r))),Image.LANCZOS)
    im.paste(a,(x0+(x1-x0-a.width)//2,y0+(y1-y0-a.height)//2),a)
    if label: d.text((x0,y1+10),label,font=fnt(20),fill=LAB)
P=lambda n: f"{F}/png/sprayland-{n}-2048.png"
d.text((60,30),"SPRAY.LAND  /  BRAND KIT",font=fnt(34),fill="#ffffff")
y=100
paste(P("lockup-transparent"),(60,y,1940,y+330),"#060a14","lockup-dark / lockup-transparent"); y+=380
paste(P("lockup-light-transparent"),(60,y,1940,y+330),"#ffffff","lockup-light / lockup-light-transparent"); y+=380
paste(P("lockup-stacked-transparent"),(60,y,980,y+440),"#060a14","lockup-stacked-dark")
paste(P("lockup-stacked-light-transparent"),(1020,y,1940,y+440),"#ffffff","lockup-stacked-light"); y+=490
paste(P("lockup-black"),(60,y,980,y+200),"#ffffff","lockup-black (one colour)")
paste(P("lockup-white"),(1020,y,1940,y+200),"#060a14","lockup-white (one colour)"); y+=250
marks=[("mark-transparent","#060a14","mark-dark"),("mark-transparent","#ffffff","mark-light"),("mark-black","#ffffff","mark-black"),
       ("mark-white","#060a14","mark-white"),("mark-small-black","#ffffff","mark-small-black"),("mark-small-white","#060a14","mark-small-white")]
x=60; s=290
for n,bg,lab in marks:
    p=P(n) if os.path.exists(P(n)) else f"{F}/png/sprayland-{n}-512.png"
    paste(p,(x,y,x+s,y+s),bg,lab); x+=s+28
y+=s+60
paste(f"{F}/social/sprayland-og-image-1200x630.png",(60,y,60+760,y+399),None,"og-image 1200x630",scale=1)
av=Image.open(f"{F}/social/sprayland-social-avatar-400.png").convert("RGBA").resize((399,399),Image.LANCZOS)
m=Image.new("L",av.size,0); ImageDraw.Draw(m).ellipse((0,0,398,398),fill=255); im.paste(av,(880,y),m)
d.text((880,y+409),"social-avatar (circle crop)",font=fnt(20),fill=LAB)
# favicon sizes
x=1340
for sz in (16,32,48):
    a=Image.open(f"{T}/ico{sz}.png").convert("RGBA"); im.paste(a,(x,y+200-sz),a); d.text((x,y+215),f"{sz}",font=fnt(20),fill=LAB); x+=max(sz,40)+30
a=Image.open(f"{F}/favicon/apple-touch-icon-180.png").convert("RGBA"); im.paste(a,(x,y+20),a); d.text((x,y+215),"180 px",font=fnt(20),fill=LAB)
z=Image.open(f"{T}/ico32.png").convert("RGBA").resize((150,150),Image.NEAREST); im.paste(z,(1340,y+260),z); d.text((1500,y+380),"32 px zoom",font=fnt(20),fill=LAB)
y+=470
for i,c in enumerate(["#060a14","#00e5ff","#ff2d95","#ff8c00","#ffffff"]):
    xx=60+i*230; d.rectangle((xx,y,xx+200,y+130),fill=c,outline="#2a3350",width=2); d.text((xx,y+140),c,font=fnt(22),fill=LAB)
d.text((1240,y+10),"Audiowide Regular, SIL OFL 1.1",font=fnt(24),fill="#ffffff")
d.text((1240,y+50),"clear space 0.5x mark height",font=fnt(20),fill=LAB)
d.text((1240,y+80),"lockup >= 120 px wide, mark >= 32 px",font=fnt(20),fill=LAB)
d.text((1240,y+110),"simplified mark at 48 px and below",font=fnt(20),fill=LAB)
im=im.crop((0,0,W,y+200)); im.save(f"{F}/preview-sheet.png"); print("preview",im.size)
