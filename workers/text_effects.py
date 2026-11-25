"""Bounded, evidence-based glyph seeds and local effect alpha on textured RGB."""
import cv2
import numpy as np
from text_support import white_stroke_support,constrain_repeated_shadow


def _line_seed(binary, inside, minor_evidence=None):
    height,width=inside.shape
    ys,xs=np.nonzero(inside)
    if not len(ys):return None
    line_height=max(1,int(ys.max()-ys.min()+1))
    line_width=max(1,int(xs.max()-xs.min()+1))
    n,labels,stats,centers=cv2.connectedComponentsWithStats((binary&(inside>0)).astype(np.uint8),8)
    main=[i for i in range(1,n) if stats[i,cv2.CC_STAT_HEIGHT]>=line_height*.32
          and stats[i,cv2.CC_STAT_HEIGHT]<=line_height*1.01
          and stats[i,cv2.CC_STAT_WIDTH]<line_width*.55 and stats[i,cv2.CC_STAT_AREA]>=6]
    if len(main)<3 or np.ptp(centers[main,0])<line_width*.35:return None
    heights=stats[main,cv2.CC_STAT_HEIGHT]
    if heights.max()>heights.min()*2.4 or np.std(centers[main,1])>line_height*.2:return None
    main_mask=np.isin(labels,main)
    occupancy=float(main_mask.sum())/max(1,int(inside.sum()))
    if not .012<occupancy<.48:return None
    keep=list(main)
    supported_minor=np.bincount(labels[minor_evidence&(inside>0)],minlength=n) if minor_evidence is not None else None
    for i in range(1,n):
        if i in main:continue
        x,y,w,h,area=stats[i]
        if h>line_height*.4 or w>line_height*.5:continue
        for j in main:
            gx,gy,gw,gh,_=stats[j]
            # Include separated Vietnamese accents, dots and punctuation.
            if gx-3<=centers[i,0]<=gx+gw+line_height*.22 and gy-gh*.5<=centers[i,1]<=gy+gh+line_height*.15:
                if supported_minor is not None and supported_minor[i]==0:
                    # Weak bright blobs inside a dark outline may be background
                    # counters, not ink. Allow faint accents above the glyph or
                    # truly small punctuation, not arbitrary interior islands.
                    accessory=(y+h<=gy+gh*.22) or (h<=line_height*.18 and w<=line_height*.18 and area<=line_height*.15)
                    if not accessory:continue
                keep.append(i);break
    seed=np.isin(labels,keep)
    return seed,line_height,len(main)


def _background(rgb, excluded):
    """Nearest observed background donors, smoothed locally; never exported RGB."""
    _,labels=cv2.distanceTransformWithLabels(excluded.astype(np.uint8),cv2.DIST_L2,5,labelType=cv2.DIST_LABEL_PIXEL)
    known=~excluded
    if known.sum()<24:return None
    colors=np.zeros((int(labels.max())+1,3),np.float32)
    colors[labels[known]]=rgb[known]
    return cv2.GaussianBlur(colors[labels],(0,0),2.0)


def _project(rgb,background,color):
    direction=color-background
    delta=rgb.astype(np.float32)-background
    denominator=np.sum(direction*direction,axis=2)
    alpha=np.clip(np.sum(delta*direction,axis=2)/np.maximum(denominator,100),0,1)
    residual=np.linalg.norm(delta-alpha[:,:,None]*direction,axis=2)
    return alpha,residual


def textured_text_alpha(rgb,inside):
    result=_textured_text_alpha(rgb,inside,weak=True)
    if result is None:
        result=_textured_text_alpha(rgb,inside,weak=False)
        if result is not None:result['seedFallback']='strict'
    return result


def _textured_text_alpha(rgb,inside,weak):
    """Select aligned fill evidence, then recover only locally supported effects."""
    hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
    strict_white=(hsv[:,:,2]>220)&(hsv[:,:,1]<65)
    adaptive_white=white_stroke_support(hsv,inside) if weak else strict_white
    white=adaptive_white if _line_seed(adaptive_white,inside,strict_white) is not None else strict_white
    masks=[white]
    chromatic=(hsv[:,:,2]>180)&(hsv[:,:,1]>100)&(inside>0)
    bins=hsv[:,:,0]//15
    if chromatic.any():
        histogram=np.bincount(bins[chromatic],minlength=12)
        for index in np.argsort(histogram)[-2:]:
            if histogram[index]>=12:masks.append(chromatic&(bins==index))
    masks.append((hsv[:,:,2]<55)&(hsv[:,:,1]<100))
    options=[]
    for index,binary in enumerate(masks):
        candidate=_line_seed(binary,inside,strict_white if index==0 else None)
        if candidate is not None:options.append(candidate)
    if not options:return None
    seed,line_height,glyph_count=max(options,key=lambda c:c[2])
    distance=cv2.distanceTransform((~seed).astype(np.uint8),cv2.DIST_L2,5)
    radius=min(24,max(4,int(round(line_height*.28))))
    background=_background(rgb,distance<=radius)
    if background is None:return None
    samples=rgb[seed]
    brightness=samples.mean(axis=1)
    color=np.median(samples[brightness>=np.percentile(brightness,65)],axis=0).astype(np.float32)
    fill,residual=_project(rgb,background,color)
    alpha=np.where((distance<=1.5)&(residual<28),fill,0)
    trusted=strict_white|((hsv[:,:,2]>180)&(hsv[:,:,1]>100))|((hsv[:,:,2]<55)&(hsv[:,:,1]<100))
    alpha[seed]=fill[seed]
    alpha[seed&trusted]=1
    foreground=rgb.copy()
    edge=(alpha>0)&(alpha<.995)
    foreground[edge]=np.rint(color).astype(np.uint8)

    # Learn a dark effect palette from a tight ring around the confirmed fill.
    # A dark source neighborhood alone is insufficient: require a deficit vs
    # observed background and a consistent effect color around several glyphs.
    luminance=rgb.astype(np.float32).mean(axis=2)
    bg_luminance=background.mean(axis=2)
    ring=(distance>0)&(distance<=max(3,radius*.45))
    dark=ring&(luminance<90)&(bg_luminance-luminance>25)
    effect=False
    if np.count_nonzero(dark)>max(12,seed.sum()*.08) and color.mean()>130:
        effect_color=np.percentile(rgb[dark],25,axis=0).astype(np.float32)
        shadow,error=_project(rgb,background,effect_color)
        supported=(distance>0)&(distance<=radius)&(bg_luminance-luminance>7)&(error<24)
        shadow=np.where(supported,shadow,0)
        shadow[shadow<.055]=0
        # A nearby dark decoration is not a shadow unless the observed effect
        # connects back to the glyph boundary. Do not bridge transparent gaps.
        _,effect_labels=cv2.connectedComponents((shadow>0).astype(np.uint8),8)
        attached=np.unique(effect_labels[(distance<=1.5)&(shadow>0)])
        attached=attached[attached!=0]
        shadow[~np.isin(effect_labels,attached)]=0
        shadow=constrain_repeated_shadow(shadow,seed,radius)
        alpha=np.maximum(alpha,shadow)
        corrected=(shadow>0)&(shadow>=alpha)&(shadow<.995)
        foreground[corrected]=np.rint(effect_color).astype(np.uint8)
        effect=bool(np.count_nonzero(shadow>.1))
        # Anti-aliased fill over an opaque outline is still opaque as a layer.
        # Projecting those gray pixels directly against background loses ink.
        if effect:
            _,ink_error=_project(rgb,np.broadcast_to(effect_color,rgb.shape),color)
            observed_outline=(np.linalg.norm(rgb.astype(float)-effect_color,axis=2)<10)&(shadow>.8)&(inside>0)
            near_outline=cv2.dilate(observed_outline.astype(np.uint8),np.ones((5,5),np.uint8))>0
            alpha[(distance<=1.5)&(ink_error<18)&near_outline]=1
    # Repeated chromatic plateaus close to several confirmed glyphs provide
    # evidence for additional outline colors. Do not collapse them into fill.
    # Quantized RGB bins collect existing colors only; no random clustering.
    chroma=rgb.max(axis=2).astype(float)-rgb.min(axis=2)
    evidence=(distance>0)&(distance<=max(4,radius*.7))&(chroma>65)&(np.linalg.norm(rgb-background,axis=2)>45)
    quantized=rgb.astype(np.int32)//24
    keys=quantized[:,:,0]*121+quantized[:,:,1]*11+quantized[:,:,2]
    histogram=np.bincount(keys[evidence],minlength=1331)
    palette=[]
    for key in np.argsort(histogram)[::-1][:8]:
        sample=evidence&(keys==key)
        if sample.sum()<max(18,seed.sum()*.035):continue
        ys,xs=np.nonzero(sample)
        if np.ptp(xs)<np.ptp(np.nonzero(seed)[1])*.35:continue
        candidate=np.median(rgb[sample],axis=0).astype(np.float32)
        if np.linalg.norm(candidate-color)<35 or any(np.linalg.norm(candidate-c)<32 for c in palette):continue
        palette.append(candidate)
    if palette:
        model_colors=[color]+palette
        best_error=np.full(inside.shape,np.inf,np.float32)
        effect_alpha=np.zeros(inside.shape,np.float32)
        effect_rgb=rgb.copy()
        opaque_neighbors=[]
        for candidate in model_colors:
            projected,error=_project(rgb,background,candidate)
            supported=(distance<=radius)&(error<18)&(projected>.055)&(np.linalg.norm(rgb-background,axis=2)>7)
            chosen=supported&(error<best_error)
            best_error[chosen]=error[chosen]
            effect_alpha[chosen]=projected[chosen]
            effect_rgb[chosen]=np.rint(candidate).astype(np.uint8)
            exact=(np.linalg.norm(rgb.astype(float)-candidate,axis=2)<8)&(distance<=radius)
            opaque_neighbors.append(exact)
        # Require connection through the union of all outline palettes. An
        # outer stroke can touch an inner stroke without touching the fill.
        support=(effect_alpha>0)|(alpha>.1)
        _,components=cv2.connectedComponents(support.astype(np.uint8),8)
        attached=np.unique(components[seed]);attached=attached[attached!=0]
        connected=np.isin(components,attached)
        effect_alpha[~connected]=0
        opaque_neighbors=[cv2.dilate((exact&connected).astype(np.uint8),np.ones((5,5),np.uint8))>0 for exact in opaque_neighbors]
        chosen=(effect_alpha>alpha)&(effect_alpha<.995)
        foreground[chosen]=effect_rgb[chosen]
        alpha=np.maximum(alpha,effect_alpha)
        # AA mixtures between two opaque ink colors remain opaque. Both
        # observed plateaus must be within two pixels to establish that fact.
        for i,a in enumerate(model_colors):
            for j,b in enumerate(model_colors[:i]):
                _,error=_project(rgb,np.broadcast_to(b,rgb.shape),a)
                ink=(error<10)&opaque_neighbors[i]&opaque_neighbors[j]&(distance<=radius)
                alpha[ink]=1
        effect=effect or bool(np.count_nonzero(effect_alpha>.1))
        # A neutral shadow may sit outside a colored outer stroke, beyond the
        # original fill ring. Test darkening against the observed background
        # and connect it to the recovered ink; isolated decorations stay out.
        core_distance=cv2.distanceTransform((alpha<.9).astype(np.uint8),cv2.DIST_L2,5)
        neutral,error=_project(rgb,background,np.zeros(3,np.float32))
        supported=(distance<=radius)&(core_distance<=min(10,radius*.6))&(error<16)&(bg_luminance-luminance>10)
        neutral=np.where(supported,neutral,0);neutral[neutral<.055]=0
        _,components=cv2.connectedComponents(((neutral>0)|(alpha>.1)).astype(np.uint8),8)
        attached=np.unique(components[seed]);attached=attached[attached!=0]
        neutral[~np.isin(components,attached)]=0
        neutral=constrain_repeated_shadow(neutral,seed,radius)
        chosen=(neutral>alpha)&(neutral<.995)
        foreground[chosen]=0
        alpha=np.maximum(alpha,neutral)
    # Keep spatial association; no convex hull and no opaque dilation.
    alpha[distance>radius]=0
    occupancy=float(np.count_nonzero(alpha>.65))/max(1,int(inside.sum()))
    # Dense outlines / broad shadows may occupy more than a fill-only line.
    if occupancy>.80:return None
    alpha=np.rint(alpha*255).astype(np.uint8)
    # Foreground estimates are strictly for fractional-alpha edges. Every
    # opaque pixel keeps its original flattened RGB byte for byte.
    foreground[(alpha==0)|(alpha==255)]=rgb[(alpha==0)|(alpha==255)]
    return {'alpha':alpha,'foreground':foreground,'method':'local-glyph-effects',
            'backgroundResidual':None,'effectRadius':radius,'effectsDetected':effect,
            'glyphComponents':glyph_count,'outlinePaletteCount':len(palette),'uncertainEffects':True}
