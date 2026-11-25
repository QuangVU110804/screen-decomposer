"""Independent known-alpha sources for thin strokes and nuisance-background QA."""
import cv2
import numpy as np


def blurred_thin_text():
    h,w=95,410;yy,xx=np.mgrid[:h,:w]
    bg=np.stack((65+15*np.sin(xx/21),95+12*np.cos(yy/13),115+12*np.sin((xx+yy)/23)),axis=2)
    ink=np.zeros((h,w),np.uint8)
    cv2.putText(ink,'THIN ROUND',(18,65),cv2.FONT_HERSHEY_SIMPLEX,1.25,255,1,cv2.LINE_AA)
    alpha=cv2.GaussianBlur(ink.astype(float)/255,(0,0),.65)
    foreground=np.full((h,w,3),250.0)
    rgb=np.rint(bg*(1-alpha[:,:,None])+foreground*alpha[:,:,None]).astype(np.uint8)
    return rgb,alpha,foreground,np.array([[10,24],[282,24],[282,76],[10,76]])


def shadow_on_texture(rect=(40,84,55,93),color=(25,32,39)):
    h,w=110,390;yy,xx=np.mgrid[:h,:w]
    background=np.stack((110+35*np.sin(xx/29),145+25*np.cos(yy/13),120+20*np.sin((xx+yy)/19)),axis=2)
    x0,y0,x1,y1=rect
    nuisance=np.zeros((h,w),bool);nuisance[y0:y1,x0:x1]=True
    background[nuisance]=color
    fill=np.zeros((h,w),np.uint8);outline=fill.copy()
    cv2.putText(fill,'HELLO!',(24,74),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,3,cv2.LINE_AA)
    cv2.putText(outline,'HELLO!',(24,74),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,9,cv2.LINE_AA)
    shadow=cv2.GaussianBlur(np.roll(outline,(5,4),(0,1)),(0,0),2.2).astype(float)/255*.65
    alpha=np.zeros((h,w));premul=np.zeros((h,w,3))
    for mask,color in [(shadow,(0,0,0)),(outline/255,(12,12,12)),(fill/255,(250,250,250))]:
        premul=premul*(1-mask[:,:,None])+np.array(color)*mask[:,:,None]
        alpha=1-(1-alpha)*(1-mask)
    foreground=premul/np.maximum(alpha[:,:,None],1e-8)
    rgb=np.rint(premul+background*(1-alpha[:,:,None])).astype(np.uint8)
    return rgb,alpha,foreground,nuisance,np.array([[17,27],[230,27],[230,82],[17,82]])


def narrow_outlined_text():
    h,w=130,620;yy,xx=np.mgrid[:h,:w]
    bg=np.stack((110+35*np.sin(xx/29),145+25*np.cos(yy/13),120+20*np.sin((xx+yy)/19)),2)
    fill=np.zeros((h,w),np.uint8);outline=fill.copy()
    cv2.putText(fill,'iiiiiii!!',(24,84),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,3,cv2.LINE_AA)
    cv2.putText(outline,'iiiiiii!!',(24,84),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,9,cv2.LINE_AA)
    shadow=cv2.GaussianBlur(np.roll(outline,(-4,-6),(0,1)),(0,0),1.3)/255*.65
    alpha=np.zeros((h,w));premul=np.zeros((h,w,3))
    for a,color in [(shadow,(0,0,0)),(outline/255,(12,12,12)),(fill/255,(250,250,250))]:
        premul=premul*(1-a[:,:,None])+np.array(color)*a[:,:,None]
        alpha=1-(1-alpha)*(1-a)
    rgb=np.rint(premul+bg*(1-alpha[:,:,None])).astype(np.uint8)
    ys,xs=np.nonzero(fill)
    poly=np.array([[xs.min()-5,ys.min()-5],[xs.max()+5,ys.min()-5],[xs.max()+5,ys.max()+5],[xs.min()-5,ys.max()+5]])
    return rgb,alpha,poly
