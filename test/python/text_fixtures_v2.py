"""Independent layered compositor used by text edge regression and saved QA."""
import cv2
import numpy as np


def multicolor_text():
    h,w=130,410
    yy,xx=np.mgrid[:h,:w]
    background=np.stack((110+35*np.sin(xx/29),145+25*np.cos(yy/13),120+20*np.sin((xx+yy)/19)),axis=2)
    masks=[]
    for thickness in (15,9,3):
        mask=np.zeros((h,w),np.uint8)
        cv2.putText(mask,'HELLO!',(28,86),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,thickness,cv2.LINE_AA)
        masks.append(mask.astype(float)/255)
    shadow=cv2.GaussianBlur(np.roll(masks[0],(5,4),(0,1)),(0,0),2.2)*.65
    alpha=np.zeros((h,w));premul=np.zeros((h,w,3))
    for a,color in [(shadow,(0,0,0)),(masks[0],(20,210,245)),(masks[1],(235,25,180)),(masks[2],(250,250,250))]:
        premul=premul*(1-a[:,:,None])+np.array(color)*a[:,:,None]
        alpha=alpha*(1-a)+a
    foreground=premul/np.maximum(alpha[:,:,None],1e-8)
    rgb=np.rint(premul+background*(1-alpha[:,:,None])).astype(np.uint8)
    return rgb,alpha,foreground,masks,shadow,np.array([[18,34],[246,34],[246,99],[18,99]])
