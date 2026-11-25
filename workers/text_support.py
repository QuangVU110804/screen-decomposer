"""Bounded local support for observed faint glyphs and repeated text effects."""
import cv2
import numpy as np


def white_stroke_support(hsv,inside):
    """Include bright-on-local-background strokes, not only near-white peaks."""
    rows=np.flatnonzero(inside.any(axis=1))
    if not len(rows):return np.zeros(inside.shape,bool)
    height=int(rows[-1]-rows[0]+1)
    size=max(7,min(31,int(height*.25)))|1
    value=hsv[:,:,2]
    local_background=cv2.morphologyEx(value,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(size,size)))
    contrast=cv2.subtract(value,local_background)
    strong=(value>220)&(hsv[:,:,1]<65)
    weak=(value>145)&(hsv[:,:,1]<90)&(contrast>18)
    return strong|weak


def constrain_repeated_shadow(alpha,seed,radius):
    """Cap isolated darkening by the repeated directional profile of glyphs.

    This only removes source-supported alpha; it never paints template pixels.
    Several glyphs must support a profile cell, otherwise leave it unchanged.
    """
    n,components,stats,_=cv2.connectedComponentsWithStats(seed.astype(np.uint8),8)
    heights=stats[1:,cv2.CC_STAT_HEIGHT]
    if not len(heights):return alpha
    typical=float(np.percentile(heights,75))
    main=[i for i in range(1,n) if stats[i,cv2.CC_STAT_HEIGHT]>=max(5,typical*.55)
          and stats[i,cv2.CC_STAT_AREA]>=8]
    if len(main)<3:return alpha
    distance,nearest=cv2.distanceTransformWithLabels((~seed).astype(np.uint8),cv2.DIST_L2,5,labelType=cv2.DIST_LABEL_PIXEL)
    yy,xx=np.indices(seed.shape)
    donor_y=np.zeros(int(nearest.max())+1,np.int32);donor_x=donor_y.copy()
    donor_y[nearest[seed]]=yy[seed];donor_x[nearest[seed]]=xx[seed]
    dy=yy-donor_y[nearest];dx=xx-donor_x[nearest]
    sector=np.floor((np.arctan2(dy,dx)+np.pi)*4/np.pi).astype(np.int32)%8
    radial=np.minimum(radius,np.floor(distance).astype(np.int32))
    group=components[donor_y[nearest],donor_x[nearest]]
    mapping=np.full(n,-1,np.int32);mapping[main]=np.arange(len(main))
    group=mapping[group]
    valid=(distance>2.5)&(distance<=radius)&(group>=0)
    if not valid.any():return alpha
    cells=8*(radius+1)
    keys=group[valid]*cells+sector[valid]*(radius+1)+radial[valid]
    values=alpha[valid]
    order=np.lexsort((values,keys));sorted_keys=keys[order];sorted_values=values[order]
    unique,start,count=np.unique(sorted_keys,return_index=True,return_counts=True)
    enough=count>=4
    profiles=np.full(len(main)*cells,np.nan,np.float32)
    # A per-glyph quantile first prevents one large background patch from
    # outweighing the other glyphs just because it contains many pixels.
    profiles[unique[enough]]=sorted_values[start[enough]+np.floor((count[enough]-1)*.75).astype(int)]
    profiles=profiles.reshape(len(main),8,radius+1)
    known=np.count_nonzero(np.isfinite(profiles),axis=0)
    # Avoid all-NaN warnings for sparsely sampled direction/radius combinations.
    envelope=np.ones((8,radius+1),np.float32)
    supported=known>=3
    for direction,r in zip(*np.nonzero(supported)):
        samples=profiles[:,direction,r];samples=samples[np.isfinite(samples)]
        envelope[direction,r]=np.median(samples)
    # Tolerate one pixel of antialias/nearest-distance disagreement.
    cap=np.maximum.reduce([envelope,np.pad(envelope[:,:-1],((0,0),(1,0)),constant_values=1),
                           np.pad(envelope[:,1:],((0,0),(0,1)),constant_values=1)])
    cap=np.minimum(1,cap+.08)
    # The learned bins constrain a continuous image; smooth their lookup field
    # to avoid introducing hard angular/radial bands on a bright destination.
    field=cv2.GaussianBlur(cap[sector,radial],(0,0),1.2)
    result=alpha.copy()
    result[valid]=np.minimum(result[valid],field[valid])
    return result
