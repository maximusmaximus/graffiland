"""spray.land brand kit generator (v3: one-color, stacked, social; v2 artwork unchanged)."""
import math, os
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = f"{ROOT}/font/Audiowide-Regular.ttf"
NAVY="#060a14"; CYAN="#00e5ff"; MAG="#ff2d95"; ORANGE="#ff8c00"; WHITE="#ffffff"; VIOLET="#7a45ff"
SH1="#4430b4"; SH2="#2a2380"

def hx(c): c=c.lstrip('#'); return [int(c[i:i+2],16) for i in (0,2,4)]
def tohex(r): return '#%02x%02x%02x' % tuple(max(0,min(255,round(v))) for v in r)
def mix(a,b,t): a,b=hx(a),hx(b); return tohex([a[i]+(b[i]-a[i])*t for i in range(3)])
def ramp(t, stops):
    t=max(0,min(1,t))
    for (t0,c0),(t1,c1) in zip(stops,stops[1:]):
        if t<=t1: return mix(c0,c1,(t-t0)/(t1-t0))
    return stops[-1][1]
FULL_STOPS=[(0,MAG),(0.5,VIOLET),(1,CYAN)]          # bottom -> top
SMALL_STOPS=[(0,MAG),(1,CYAN)]

C=math.cos(math.radians(30))
def P(x,y,z): return ((x-y)*C,(x+y)*0.5-z)
def poly(ps): return "M"+" L".join(f"{a:.3f},{b:.3f}" for a,b in ps)+"Z"

class Model:
    def __init__(self, small=False):
        self.small=small
        self.BW=2 if small else 4; self.BH=4 if small else 6
        BW,BH=self.BW,self.BH
        c=[]
        for z in range(BH):
            for x in range(BW):
                for y in range(BW): c.append((x,y,z,1,'body'))
        if small:
            c.append((0.25,0.25,BH,1.5,'sh1'))
            c.append((0.75,0.75,BH+1.5,.5,'noz'))
            sp=[(1.65,0.45,BH+1.55,.5),(2.45,-0.15,BH+2.05,.5),(3.25,-0.75,BH+2.55,.5)]
        else:
            for x in range(3):
                for y in range(3): c.append((x+.5,y+.5,BH,1,'sh1'))
            for x in range(2):
                for y in range(2): c.append((x+1,y+1,BH+1,1,'sh2'))
            c.append((1.5,1.5,BH+2,1,'noz'))
            k=1.15
            sp=[(2.7,1.0,8.5,.5*k),(3.55,0.3,9.05,.5*k),(3.5,1.15,8.2,.42*k),(4.45,-0.35,9.4,.42*k),(4.4,0.75,8.6,.36*k)]
        for x,y,z,s in sp: c.append((x,y,z,s,'spray'))
        self.cubes=c
        self.occ=set((x,y,z) for x,y,z,s,k in c if s==1)

    def colors(self,kind,fz,fx_n):
        if kind=='body':
            stops=SMALL_STOPS if self.small else FULL_STOPS
            base=ramp(0.88*(fz/self.BH)+0.12*fx_n, stops)
            return {'top':mix(base,WHITE,.25),'left':base,'right':mix(base,"#000000",.28 if self.small else .18)}
        b={'sh1':SH1,'sh2':SH2,'noz':ORANGE,'spray':CYAN}[kind]
        if kind=='spray': return {'top':mix(b,WHITE,.6),'left':b,'right':mix(b,"#000000",.22)}
        if kind=='noz': return {'top':mix(b,WHITE,.3),'left':b,'right':mix(b,"#000000",.2)}
        return {'top':mix(b,WHITE,.22),'left':b,'right':mix(b,"#000000",.32)}

    def bbox(self, include_spray=True):
        xs=[];ys=[]
        for x,y,z,s,k in self.cubes:
            if k=='spray' and not include_spray: continue
            for dx in (0,s):
                for dy in (0,s):
                    for dz in (0,s):
                        a,b=P(x+dx,y+dy,z+dz); xs.append(a); ys.append(b)
        return min(xs),min(ys),max(xs),max(ys)

    def body_center_y(self):
        # optical centre of the body block (front silhouette)
        return (P(0,0,self.BH)[1]+P(self.BW,self.BW,0)[1])/2

    def elems(self, uid):
        BW,BH=self.BW,self.BH
        sx0=P(0,BW,0)[0]; sx1=P(BW,0,0)[0]
        out=[]; glow=[]; defs=[]
        order=sorted(self.cubes,key=lambda c:(c[4]=='spray',c[2],c[0]+c[1]))
        if self.small:   # body as three solid gradient faces, no seams
            order=[c for c in order if c[4]!='body']
            faces={'left':[P(0,BW,0),P(BW,BW,0),P(BW,BW,BH),P(0,BW,BH)],
                   'right':[P(BW,0,0),P(BW,BW,0),P(BW,BW,BH),P(BW,0,BH)]}
            for f,ps in faces.items():
                y_bot=P(BW,BW,0)[1]; y_top=P(BW,BW,BH)[1]
                c0=self.colors('body',0,.5)[f]; c1=self.colors('body',BH,.5)[f]
                defs.append(f'<linearGradient id="{uid}{f}" gradientUnits="userSpaceOnUse" x1="0" y1="{y_bot:.3f}" x2="0" y2="{y_top:.3f}"><stop offset="0.2" stop-color="{c0}"/><stop offset="1" stop-color="{c1}"/></linearGradient>')
                out.append(f'<path d="{poly(ps)}" fill="url(#{uid}{f})"/>')
            T=[P(0,0,BH),P(BW,0,BH),P(BW,BW,BH),P(0,BW,BH)]
            out.append(f'<path d="{poly(T)}" fill="{self.colors("body",BH,.5)["top"]}"/>')
        for x,y,z,s,k in order:
            F={'top':[P(x,y,z+s),P(x+s,y,z+s),P(x+s,y+s,z+s),P(x,y+s,z+s)],
               'left':[P(x,y+s,z),P(x+s,y+s,z),P(x+s,y+s,z+s),P(x,y+s,z+s)],
               'right':[P(x+s,y,z),P(x+s,y+s,z),P(x+s,y+s,z+s),P(x+s,y,z+s)]}
            skip={'top':s==1 and (x,y,z+1) in self.occ,'left':s==1 and (x,y+1,z) in self.occ,'right':s==1 and (x+1,y,z) in self.occ}
            for f,ps in F.items():
                if skip[f]: continue
                fx=sum(p[0] for p in ps)/4
                col=self.colors(k,z+.5,(fx-sx0)/(sx1-sx0))[f]
                if self.small:
                    out.append(f'<path d="{poly(ps)}" fill="{col}"/>')
                else:
                    out.append(f'<path d="{poly(ps)}" fill="{col}" stroke="{mix(col,"#000000",.32)}" stroke-width="0.05" stroke-linejoin="round"/>')
            if k=='spray' and not self.small:
                h=[P(x,y,z+s),P(x+s,y,z+s),P(x+s,y,z),P(x+s,y+s,z),P(x,y+s,z),P(x,y+s,z+s)]
                glow.append(f'<path d="{poly(h)}" fill="{CYAN}"/>')
        if glow:
            defs.append(f'<filter id="{uid}glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="0.45"/></filter>')
            out=[f'<g filter="url(#{uid}glow)" opacity="0.55">'+"".join(glow)+'</g>']+out
        return "".join(defs),"".join(out)

    def group(self,scale,tx,ty,uid,mono=None):
        d,e=(("",self.mono_elems(mono)) if mono else self.elems(uid))
        return d,f'<g transform="translate({tx:.3f},{ty:.3f}) scale({scale:.4f})">{e}</g>'

FULL=Model(False); SMALL=Model(True)

# ---------- wordmark ----------
tt=TTFont(FONT); gs=tt.getGlyphSet(); upm=tt['head'].unitsPerEm
CAP=tt['OS/2'].sCapHeight
_font=hb.Font(hb.Face(hb.Blob.from_file_path(FONT)))
TRACK=-0.018
PAIR={('Y','.'):-0.045,('.','L'):-0.025}
def wordmark_path(text="SPRAY.LAND"):
    buf=hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
    hb.shape(_font,buf,{"kern":True})
    pen=SVGPathPen(gs); bp=BoundsPen(gs); x=0; order=tt.getGlyphOrder()
    infos=list(zip(buf.glyph_infos,buf.glyph_positions))
    for i,(info,pos) in enumerate(infos):
        g=order[info.codepoint]
        t=(1,0,0,-1,x+pos.x_offset,-pos.y_offset)
        gs[g].draw(TransformPen(pen,t)); gs[g].draw(TransformPen(bp,t))
        x+=pos.x_advance
        if i<len(infos)-1:
            x+=TRACK*upm+PAIR.get((text[i],text[i+1]),0)*upm
    return pen.getCommands(),bp.bounds
WM_D,WM_B=wordmark_path()

def svg(w,h,body,defs="",bg=None):
    r=f'<rect width="{w:.2f}" height="{h:.2f}" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}">'
            f'<title>spray.land</title><defs>{defs}</defs>{r}{body}</svg>\n')

def build_mark(model,bg=None,pad=0.08,uid="m"):
    x0,y0,x1,y1=model.bbox(); mw,mh=x1-x0,y1-y0
    S=1000; sc=S*(1-2*pad)/max(mw,mh)
    tx=(S-mw*sc)/2-x0*sc; ty=(S-mh*sc)/2-y0*sc
    d,g=model.group(sc,tx,ty,uid); return svg(S,S,g,d,bg)

def build_wordmark(color=WHITE,bg=None,pad=0.06):
    x0,y0,x1,y1=WM_B; w=x1-x0; h=y1-y0; k=1000*(1-2*pad)/w
    W=1000; H=h*k+pad*1000
    tx=pad*1000-x0*k; ty=(H-h*k)/2-y0*k
    return svg(W,H,f'<path transform="translate({tx:.3f},{ty:.3f}) scale({k:.5f})" d="{WM_D}" fill="{color}"/>','',bg)

def build_lockup(color=WHITE,bg=None,uid="l"):
    m=FULL
    bx0,by0,bx1,by1=m.bbox(include_spray=False)   # body+shoulders+nozzle
    ax0,ay0,ax1,ay1=m.bbox(include_spray=True)
    capH=200.0; k=capH/CAP
    MH=1.08*capH; ms=MH/(by1-by0)
    clear=0.5*MH; gap=0.40*capH
    wx0,wy0,wx1,wy1=WM_B
    # vertical: body optical centre == cap midpoint. Put that line at y=Yc.

    # compute extents relative to centre line
    mark_top=(ay0-m.body_center_y())*ms; mark_bot=(ay1-m.body_center_y())*ms
    txt_top=-capH/2; txt_bot=capH/2+max(0,wy1)*k   # baseline at +capH/2
    top=min(mark_top,txt_top); bot=max(mark_bot,txt_bot)
    Yc=clear-top
    H=Yc+bot+clear
    mtx=clear-ax0*ms; mty=Yc-m.body_center_y()*ms
    ttx=clear+(ax1-ax0)*ms+gap-wx0*k; tty=Yc+capH/2
    W=ttx+wx1*k+clear
    d,g=m.group(ms,mtx,mty,uid)
    t=f'<path transform="translate({ttx:.3f},{tty:.3f}) scale({k:.5f})" d="{WM_D}" fill="{color}"/>'
    return svg(W,H,g+t,d,bg)

# ---------- one-colour (monochrome) rendering ----------
# Same geometry and painter order as the colour mark. Each visible face is
# clipped by the faces in front of it, then inset so faces read as separate
# voxels through thin knockout gaps (works on any background, no white fill).
from shapely.geometry import Polygon
from shapely.ops import unary_union
MONO_GAP = 0.07   # gap width in cube units

def _mono_faces(model):
    BW,BH=model.BW,model.BH; faces=[]
    order=sorted(model.cubes,key=lambda c:(c[4]=='spray',c[2],c[0]+c[1]))
    if model.small:
        order=[c for c in order if c[4]!='body']
        faces += [[P(0,BW,0),P(BW,BW,0),P(BW,BW,BH),P(0,BW,BH)],
                  [P(BW,0,0),P(BW,BW,0),P(BW,BW,BH),P(BW,0,BH)],
                  [P(0,0,BH),P(BW,0,BH),P(BW,BW,BH),P(0,BW,BH)]]
    for x,y,z,s,k in order:
        F={'top':[P(x,y,z+s),P(x+s,y,z+s),P(x+s,y+s,z+s),P(x,y+s,z+s)],
           'left':[P(x,y+s,z),P(x+s,y+s,z),P(x+s,y+s,z+s),P(x,y+s,z+s)],
           'right':[P(x+s,y,z),P(x+s,y+s,z),P(x+s,y+s,z+s),P(x+s,y,z+s)]}
        skip={'top':s==1 and (x,y,z+1) in model.occ,'left':s==1 and (x,y+1,z) in model.occ,'right':s==1 and (x+1,y,z) in model.occ}
        for f,ps in F.items():
            if not skip[f]: faces.append(ps)
    return faces

def _ring(coords):
    pts=list(coords)[:-1]
    return "M"+" L".join(f"{a:.3f},{b:.3f}" for a,b in pts)+"Z"

def _mono_path(model):
    covered=None; parts=[]
    for ps in reversed(_mono_faces(model)):          # front to back
        p=Polygon(ps)
        vis=p if covered is None else p.difference(covered)
        covered=p if covered is None else unary_union([covered,p])
        vis=vis.buffer(-MONO_GAP/2,join_style=2,mitre_limit=5)
        for g in getattr(vis,'geoms',[vis]):
            if g.is_empty or g.geom_type!='Polygon' or g.area<1e-4: continue
            parts.append(_ring(g.exterior.coords)+"".join(_ring(i.coords) for i in g.interiors))
    return "".join(parts)

def _mono_elems(self,ink): return f'<path d="{_mono_path(self)}" fill="{ink}" fill-rule="evenodd"/>'
Model.mono_elems=_mono_elems

# ---------- builders ----------
def build_mark(model,bg=None,pad=0.08,uid="m",mono=None,S=1000):
    x0,y0,x1,y1=model.bbox(); mw,mh=x1-x0,y1-y0
    sc=S*(1-2*pad)/max(mw,mh)
    tx=(S-mw*sc)/2-x0*sc; ty=(S-mh*sc)/2-y0*sc
    d,g=model.group(sc,tx,ty,uid,mono); return svg(S,S,g,d,bg)

def _lockup_parts(color,mono,uid):
    """Horizontal lockup content without outer clear space. Returns (defs, body, w, h)."""
    m=FULL
    bx0,by0,bx1,by1=m.bbox(include_spray=False)
    ax0,ay0,ax1,ay1=m.bbox(include_spray=True)
    capH=200.0; k=capH/CAP
    MH=1.08*capH; ms=MH/(by1-by0); gap=0.40*capH
    wx0,wy0,wx1,wy1=WM_B
    mark_top=(ay0-m.body_center_y())*ms; mark_bot=(ay1-m.body_center_y())*ms
    txt_top=-capH/2; txt_bot=capH/2+max(0,wy1)*k
    top=min(mark_top,txt_top); bot=max(mark_bot,txt_bot)
    Yc=-top
    mtx=-ax0*ms; mty=Yc-m.body_center_y()*ms
    ttx=(ax1-ax0)*ms+gap-wx0*k; tty=Yc+capH/2
    d,g=m.group(ms,mtx,mty,uid,mono)
    t=f'<path transform="translate({ttx:.3f},{tty:.3f}) scale({k:.5f})" d="{WM_D}" fill="{mono or color}"/>'
    return d,g+t,ttx+wx1*k,Yc+bot,MH

def build_lockup(color=WHITE,bg=None,uid="l",mono=None):
    d,body,w,h,MH=_lockup_parts(color,mono,uid); clear=0.5*MH
    return svg(w+2*clear,h+2*clear,f'<g transform="translate({clear:.3f},{clear:.3f})">{body}</g>',d,bg)

def build_stacked(color=WHITE,bg=None,uid="k",mono=None):
    """Mark centred above the wordmark. Mark height (body+shoulders+nozzle) = 2.4 x cap height."""
    m=FULL
    bx0,by0,bx1,by1=m.bbox(include_spray=False)
    ax0,ay0,ax1,ay1=m.bbox(include_spray=True)
    capH=200.0; k=capH/CAP; MH=2.4*capH; ms=MH/(by1-by0)
    wx0,wy0,wx1,wy1=WM_B; ww=(wx1-wx0)*k
    clear=0.5*MH; gap=0.45*capH
    axis=P(m.BW/2,m.BW/2,0)[0]                  # vertical axis of the can body
    left=min(-ww/2,(ax0-axis)*ms); right=max(ww/2,(ax1-axis)*ms)
    cx=clear-left
    mtx=cx-axis*ms; mty=clear-ay0*ms
    mark_bottom=clear+(ay1-ay0)*ms
    base=mark_bottom+gap+capH
    ttx=cx-ww/2-wx0*k
    W=cx+right+clear; H=base+max(0,wy1)*k+clear
    d,g=m.group(ms,mtx,mty,uid,mono)
    t=f'<path transform="translate({ttx:.3f},{base:.3f}) scale({k:.5f})" d="{WM_D}" fill="{mono or color}"/>'
    return svg(W,H,g+t,d,bg)

def build_avatar(S=1000):
    """Square social avatar on navy; full mark kept inside the inscribed circle."""
    return build_mark(FULL,bg=NAVY,pad=0.17,uid="a",S=S)

def build_og(W=1200,H=630):
    d,body,w,h,MH=_lockup_parts(WHITE,None,"o")
    s=W*0.74/w; tx=(W-w*s)/2; ty=(H-h*s)/2
    return svg(W,H,f'<g transform="translate({tx:.3f},{ty:.3f}) scale({s:.5f})">{body}</g>',d,NAVY)

BLACK="#000000"
FILES={
 # mark
 "svg/sprayland-mark-transparent.svg":lambda:build_mark(FULL),
 "svg/sprayland-mark-dark.svg":lambda:build_mark(FULL,bg=NAVY),
 "svg/sprayland-mark-light.svg":lambda:build_mark(FULL,bg=WHITE),
 "svg/sprayland-mark-black.svg":lambda:build_mark(FULL,mono=BLACK),
 "svg/sprayland-mark-white.svg":lambda:build_mark(FULL,mono=WHITE),
 "svg/sprayland-mark-small-transparent.svg":lambda:build_mark(SMALL,pad=0.04,uid="s"),
 "svg/sprayland-mark-small-black.svg":lambda:build_mark(SMALL,pad=0.04,mono=BLACK),
 "svg/sprayland-mark-small-white.svg":lambda:build_mark(SMALL,pad=0.04,mono=WHITE),
 "svg/sprayland-mark-favicon.svg":lambda:build_mark(SMALL,bg=NAVY,pad=0.04,uid="s"),
 # horizontal lockup
 "svg/sprayland-lockup-transparent.svg":lambda:build_lockup(),
 "svg/sprayland-lockup-dark.svg":lambda:build_lockup(bg=NAVY),
 "svg/sprayland-lockup-light.svg":lambda:build_lockup(color=NAVY,bg=WHITE),
 "svg/sprayland-lockup-light-transparent.svg":lambda:build_lockup(color=NAVY),
 "svg/sprayland-lockup-black.svg":lambda:build_lockup(mono=BLACK),
 "svg/sprayland-lockup-white.svg":lambda:build_lockup(mono=WHITE),
 # stacked lockup
 "svg/sprayland-lockup-stacked-transparent.svg":lambda:build_stacked(),
 "svg/sprayland-lockup-stacked-dark.svg":lambda:build_stacked(bg=NAVY),
 "svg/sprayland-lockup-stacked-light.svg":lambda:build_stacked(color=NAVY,bg=WHITE),
 "svg/sprayland-lockup-stacked-light-transparent.svg":lambda:build_stacked(color=NAVY),
 "svg/sprayland-lockup-stacked-black.svg":lambda:build_stacked(mono=BLACK),
 "svg/sprayland-lockup-stacked-white.svg":lambda:build_stacked(mono=WHITE),
 # wordmark
 "svg/sprayland-wordmark-white-transparent.svg":lambda:build_wordmark(),
 "svg/sprayland-wordmark-dark.svg":lambda:build_wordmark(bg=NAVY),
 "svg/sprayland-wordmark-navy-transparent.svg":lambda:build_wordmark(color=NAVY),
 "svg/sprayland-wordmark-light.svg":lambda:build_wordmark(color=NAVY,bg=WHITE),
 "svg/sprayland-wordmark-black.svg":lambda:build_wordmark(color=BLACK),
 # social
 "social/sprayland-social-avatar.svg":lambda:build_avatar(),
 "social/sprayland-og-image.svg":lambda:build_og(),
}

if __name__=="__main__":
    for n,f in FILES.items():
        p=f"{ROOT}/{n}"; os.makedirs(os.path.dirname(p),exist_ok=True)
        open(p,"w").write(f())
    print("ok",len(FILES))
