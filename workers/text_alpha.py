"""Conservative glyph alpha from a smooth observed background, never inpainting."""
import cv2
import numpy as np
from text_effects import textured_text_alpha


def estimate_text_alpha(rgb,polygon):
    """Keep native detail in long lines with bounded overlapping analysis tiles."""
    height,width=rgb.shape[:2]
    if height*width<=350000:return _estimate_tile(rgb,polygon)
    # Oversized/tall crops cannot supply enough context in a bounded native tile.
    # Return an honest crop instead of recursively resizing away tiny strokes.
    tile_width=350000//height
    overlap=min(128,max(16,height//2))
    if tile_width<max(96,overlap*3):return None
    stride=tile_width-overlap*2
    alpha=np.zeros((height,width),np.uint8)
    foreground=rgb.copy();has_foreground=False
    methods=set();valid=0
    for left in range(0,width,stride):
        right=min(width,left+tile_width)
        points=np.asarray(polygon,dtype=float)-np.array([left,0])
        result=_estimate_tile(rgb[:,left:right],points)
        if result is None:return None
        start=0 if left==0 else overlap
        end=right-left if right==width else right-left-overlap
        alpha[:,left+start:left+end]=result['alpha'][:,start:end]
        if 'foreground' in result:
            foreground[:,left+start:left+end]=result['foreground'][:,start:end]
            has_foreground=True
        methods.add(result['method']);valid+=1
        if right==width:break
    result={'alpha':alpha,'method':'source-tiles:'+','.join(sorted(methods)),
            'analysisScale':1.0,'tiles':valid,'uncertainEffects':True}
    if has_foreground:result['foreground']=foreground
    return result


def _estimate_tile(rgb,polygon):
    height,width=rgb.shape[:2]
    if height<5 or width<5:
        return None
    inside=np.zeros((height,width),np.uint8)
    cv2.fillPoly(inside,[np.rint(polygon).astype(np.int32)],1)
    outer=~(inside>0)
    if outer.sum()<24 or inside.sum()<24:
        return None
    lab=cv2.cvtColor(rgb,cv2.COLOR_RGB2LAB).astype(np.float32)
    yy,xx=np.mgrid[0:height,0:width]
    design=np.column_stack((np.ones(height*width),xx.ravel()/max(1,width-1),yy.ravel()/max(1,height-1))).astype(np.float32)
    indices=np.flatnonzero(outer.ravel())
    indices=indices[::max(1,len(indices)//2500)]
    samples=lab.reshape(-1,3)[indices]
    matrix=design[indices]
    coefficients=np.linalg.lstsq(matrix,samples,rcond=None)[0]
    for _ in range(2):
        residual=np.linalg.norm(samples-matrix@coefficients,axis=1)
        reliable=residual<=np.percentile(residual,80)+.1
        if reliable.sum()<16:
            return None
        coefficients=np.linalg.lstsq(matrix[reliable],samples[reliable],rcond=None)[0]
    residual=np.linalg.norm(samples-matrix@coefficients,axis=1)
    error=float(np.percentile(residual,85))
    if error>14:
        return textured_text_alpha(rgb,inside)
    background=(design@coefficients).reshape(height,width,3)
    difference=np.linalg.norm(lab-background,axis=2)
    cutoff=max(14,error*2.3+5)
    alpha=np.clip((difference-cutoff)/max(12,cutoff*.8),0,1)
    allowed=cv2.dilate(inside,np.ones((3,3),np.uint8))>0
    alpha[~allowed]=0
    core=(alpha>.65).astype(np.uint8)
    n,labels,stats,_=cv2.connectedComponentsWithStats(core,8)
    keep=[];main=[]
    line_height=max(1,np.ptp(np.nonzero(inside)[0])+1)
    for label in range(1,n):
        x,y,w,h,area=stats[label]
        if area<max(2,height*width*.00015):
            continue
        if w>width*.8 and h>height*.8:
            return None
        keep.append(label)
        if h>=max(5,line_height*.25):
            main.append(label)
    if not keep:
        return None
    if not main:
        return None
    main_area=int(sum(stats[label,cv2.CC_STAT_AREA] for label in main))
    minor=[label for label in keep if label not in main]
    # Smooth padding alone does not prove the interior is a smooth background.
    # Dense decorative speckles cannot be distinguished from glyphs reliably.
    if len(minor)>max(8,len(main)*3) and sum(stats[label,cv2.CC_STAT_AREA] for label in minor)>main_area*.12:
        return None
    support=cv2.dilate(np.isin(labels,keep).astype(np.uint8),np.ones((3,3),np.uint8))>0
    alpha[~support]=0
    occupancy=np.count_nonzero(alpha>.65)/max(1,int(inside.sum()))
    if occupancy<.008 or occupancy>.58:
        return None
    detail=textured_text_alpha(rgb,inside)
    if detail is not None:
        # The validated smooth-background mask also supports minority fill
        # colors and non-dark outlines. Detail may add effects, not erase ink.
        detail['alpha']=np.maximum(detail['alpha'],np.rint(alpha*255).astype(np.uint8))
        if 'foreground' in detail:
            detail['foreground'][detail['alpha']==255]=rgb[detail['alpha']==255]
        detail['backgroundResidual']=round(error,3)
        return detail
    return {'alpha':np.rint(alpha*255).astype(np.uint8),'method':'border-plane-contrast','backgroundResidual':round(error,3)}
