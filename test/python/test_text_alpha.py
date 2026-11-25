import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
import tempfile
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'workers'))
from text_alpha import estimate_text_alpha
from masks import export_text
from text_fixtures_v2 import multicolor_text
from text_fixtures_v3 import blurred_thin_text,shadow_on_texture,narrow_outlined_text


def styled_text(foreground=(250,250,250)):
    """Independent compositor with known effect alpha, unrelated to extraction."""
    h,w=110,390
    yy,xx=np.mgrid[:h,:w]
    background=np.stack((110+35*np.sin(xx/29),145+25*np.cos(yy/13),120+20*np.sin((xx+yy)/19)),axis=2).astype(np.uint8)
    fill=np.zeros((h,w),np.uint8);outline=fill.copy()
    cv2.putText(fill,'HELLO!',(24,74),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,3,cv2.LINE_AA)
    cv2.putText(outline,'HELLO!',(24,74),cv2.FONT_HERSHEY_SIMPLEX,1.7,255,9,cv2.LINE_AA)
    shadow=cv2.GaussianBlur(np.roll(outline,(5,4),(0,1)),(0,0),2.2).astype(float)/255*.65
    rgb=background.astype(float)*(1-shadow[:,:,None])
    oa=outline.astype(float)/255;fa=fill.astype(float)/255
    rgb=rgb*(1-oa[:,:,None])+np.array([12,12,12])*oa[:,:,None]
    rgb=rgb*(1-fa[:,:,None])+np.array(foreground)*fa[:,:,None]
    combined=1-(1-shadow)*(1-oa)
    return rgb.astype(np.uint8),fill,outline,shadow,combined


class TextAlphaTests(unittest.TestCase):
    def test_narrow_dense_letters_keep_a_valid_mask_when_weak_support_is_ambiguous(self):
        rgb,truth,poly=narrow_outlined_text()
        result=estimate_text_alpha(rgb,poly)
        self.assertIsNotNone(result)
        self.assertGreater(float(np.mean(result['alpha'][truth>.95]>180)),.9)

    def test_blurred_thin_strokes_recover_without_filling_letter_counters(self):
        rgb,truth,_,poly=blurred_thin_text()
        result=estimate_text_alpha(rgb,poly)
        self.assertIsNotNone(result)
        self.assertGreater(float(np.mean(result['alpha'][truth>.32]>60)),.9)
        far=cv2.dilate((truth>.03).astype(np.uint8),np.ones((5,5),np.uint8))==0
        self.assertLess(float(np.mean(result['alpha'][far]>40)),.015)

    def test_local_dark_background_patch_does_not_become_an_opaque_shadow_fringe(self):
        rgb,truth,foreground,nuisance,poly=shadow_on_texture((40,78,55,90))
        result=estimate_text_alpha(rgb,poly)
        self.assertIsNotNone(result)
        alpha=result['alpha']/255
        self.assertLess(float(np.mean(np.maximum(0,alpha[nuisance]-truth[nuisance]))),.28)
        soft=(truth>.12)&(truth<.55)&~nuisance
        self.assertGreater(float(np.mean(alpha[soft]>.05)),.65)

    def test_weak_stroke_detection_does_not_fill_the_background_inside_a_glyph(self):
        rgb,truth,_,_,poly=shadow_on_texture()
        result=estimate_text_alpha(rgb,poly)
        counter=np.zeros(truth.shape,bool);counter[65:78,40:50]=True;counter&=truth<.02
        self.assertGreater(int(counter.sum()),15)
        self.assertLess(float(np.mean(result['alpha'][counter]/255)),.12)

    def test_nearby_dark_line_does_not_make_all_faint_ink_opaque(self):
        rgb,truth,_,poly=blurred_thin_text()
        rgb[70:74,15:290]=8
        result=estimate_text_alpha(rgb,poly)
        self.assertIsNotNone(result)
        fractional=(truth>.32)&(truth<.8)
        # A faint line has no known opaque color anchor; some peak pixels may
        # saturate the estimated matte. Nearby unrelated black ink must not
        # force nearly the entire faint line opaque (old behavior: 98.8%).
        self.assertLess(float(np.mean(result['alpha'][fractional]==255)),.4)

    def test_multiple_color_outlines_survive_textured_background(self):
        rgb,expected,_,masks,_,poly=multicolor_text()
        result=estimate_text_alpha(rgb,poly)
        self.assertIsNotNone(result)
        for rim in [(masks[0]>.98)&(masks[1]<.01),(masks[1]>.98)&(masks[2]<.01)]:
            self.assertGreater(float(np.mean(result['alpha'][rim]>220)),.9)

    def test_multicolor_outlines_retain_their_attached_soft_shadow(self):
        rgb,_,_,masks,shadow,poly=multicolor_text()
        result=estimate_text_alpha(rgb,poly)
        soft=(shadow>.12)&(shadow<.55)&(masks[0]==0)
        self.assertGreater(float(np.mean(result['alpha'][soft]>20)),.65)

    def test_antialias_between_opaque_outline_colors_stays_opaque(self):
        rgb,expected,_,_,_,poly=multicolor_text()
        result=estimate_text_alpha(rgb,poly)
        self.assertGreater(float(np.mean(result['alpha'][expected>.999]>250)),.98)

    def test_shadow_foreground_removes_background_color_and_keeps_opaque_rgb(self):
        rgb,_,outline,shadow,_=styled_text()
        result=estimate_text_alpha(rgb,np.array([[17,27],[230,27],[230,82],[17,82]]))
        self.assertIn('foreground',result)
        soft=(shadow>.12)&(shadow<.55)&(outline==0)&(result['alpha']>20)
        self.assertLess(float(np.mean(result['foreground'][soft])),25)
        np.testing.assert_array_equal(result['foreground'][result['alpha']==255],rgb[result['alpha']==255])

    def test_export_retains_full_source_crop_and_reports_actual_color_correction(self):
        rgb,_,_,_,_=styled_text()
        source=np.dstack((rgb,np.full(rgb.shape[:2],140,np.uint8)))
        with tempfile.TemporaryDirectory() as tmp:
            result=export_text(source,[[17,27],[230,27],[230,82],[17,82]],Path(tmp),'text_001')
            self.assertEqual(result['sourceFile'],'text_001.source.png')
            left,top,width,height=result['bbox']
            original=source[top:top+height,left:left+width]
            np.testing.assert_array_equal(np.array(Image.open(Path(tmp)/result['sourceFile'])),original)
            rgba=np.array(Image.open(Path(tmp)/result['file']))
            self.assertFalse(result['sourcePixelsOnly'])
            self.assertTrue(result['refinement']['colorCorrection'])
            self.assertTrue(np.all(rgba[:,:,3]<=original[:,:,3]))
            self.assertGreater(np.count_nonzero(rgba[:,:,:3]!=original[:,:,:3]),0)
            self.assertNotIn('foreground',result['refinement'])

    def test_tiled_result_carries_foreground_and_preserves_opaque_rgb(self):
        rgb,truth,foreground,_,_,_=multicolor_text()
        rgb=np.tile(rgb,(1,8,1))
        truth=np.tile(truth,(1,8));foreground=np.tile(foreground,(1,8,1))
        result=estimate_text_alpha(rgb,np.array([[18,34],[3116,34],[3116,99],[18,99]]))
        self.assertIsNotNone(result)
        self.assertIn('foreground',result)
        self.assertEqual(result['foreground'].shape,rgb.shape)
        np.testing.assert_array_equal(result['foreground'][result['alpha']==255],rgb[result['alpha']==255])
        soft=(truth>.12)&(truth<.8)
        self.assertGreater(float(np.mean(result['alpha'][soft]>20)),.65)
        active=soft&(result['alpha']>20)
        self.assertLess(float(np.mean(np.abs(result['foreground'][active].astype(float)-foreground[active]))),10)

    def test_smooth_mixed_color_line_does_not_drop_a_less_frequent_word(self):
        rgb=np.full((100,650,3),(130,65,85),np.uint8)
        white=np.zeros((100,650),np.uint8);yellow=white.copy()
        cv2.putText(white,'HELLO WORLD',(15,70),cv2.FONT_HERSHEY_SIMPLEX,1.5,255,3,cv2.LINE_AA)
        cv2.putText(yellow,'ABC',(410,70),cv2.FONT_HERSHEY_SIMPLEX,1.5,255,3,cv2.LINE_AA)
        rgb[white>240]=(250,250,250);rgb[yellow>240]=(245,235,15)
        result=estimate_text_alpha(rgb,np.array([[8,27],[550,27],[550,77],[8,77]]))
        self.assertIsNotNone(result)
        self.assertGreater(float(np.mean(result['alpha'][yellow>240]>200)),.98)
        self.assertGreater(float(np.mean(result['alpha'][white>240]>200)),.98)

    def test_colored_outline_on_smooth_background_is_preserved(self):
        for color in [(230,30,30),(20,45,240),(30,200,240)]:
            rgb=np.full((100,650,3),(130,65,85),np.uint8)
            fill=np.zeros((100,650),np.uint8);outline=fill.copy()
            cv2.putText(fill,'HELLO WORLD',(15,70),cv2.FONT_HERSHEY_SIMPLEX,1.5,255,3,cv2.LINE_AA)
            cv2.putText(outline,'HELLO WORLD',(15,70),cv2.FONT_HERSHEY_SIMPLEX,1.5,255,9,cv2.LINE_AA)
            rgb[outline>0]=color;rgb[fill>0]=(250,250,250)
            result=estimate_text_alpha(rgb,np.array([[8,27],[400,27],[400,77],[8,77]]))
            self.assertIsNotNone(result)
            self.assertGreater(float(np.mean(result['alpha'][(outline>240)&(fill==0)]>200)),.98)

    def test_colored_and_white_fill_retain_dark_outline_on_textured_background(self):
        for color in [(250,250,250),(245,235,15)]:
            rgb,fill,outline,shadow,expected=styled_text(color)
            result=estimate_text_alpha(rgb,np.array([[17,27],[230,27],[230,82],[17,82]]))
            self.assertIsNotNone(result)
            alpha=result['alpha']/255
            rim=(outline>240)&(fill<10)
            self.assertGreater(float(np.mean(alpha[rim]>.8)),.85)
            far=cv2.dilate((expected>.03).astype(np.uint8),np.ones((5,5),np.uint8))==0
            self.assertLess(float(np.mean(alpha[far]>.1)),.02)

    def test_soft_shadow_is_retained_as_partial_alpha_without_a_background_band(self):
        rgb,fill,outline,shadow,expected=styled_text()
        result=estimate_text_alpha(rgb,np.array([[17,27],[230,27],[230,82],[17,82]]))
        self.assertIsNotNone(result)
        alpha=result['alpha']/255
        soft=(shadow>.12)&(shadow<.55)&(outline==0)
        self.assertGreater(float(np.mean(alpha[soft]>.05)),.65)
        self.assertLess(float(np.mean(alpha[soft]>.95)),.1)

    def test_nearby_disconnected_dark_decoration_is_not_copied_as_shadow(self):
        rgb,_,_,_,_=styled_text()
        rgb[21:25,32:53]=12
        result=estimate_text_alpha(rgb,np.array([[17,27],[230,27],[230,82],[17,82]]))
        self.assertIsNotNone(result)
        self.assertLess(float(np.mean(result['alpha'][21:25,32:53]>20)),.1)

    def test_rotated_text_and_effects_keep_source_coordinates(self):
        rgb,fill,outline,_,_=styled_text()
        rotation=cv2.getRotationMatrix2D((195,55),5,1)
        image=cv2.warpAffine(rgb,rotation,(390,110),borderMode=cv2.BORDER_REFLECT)
        expected=cv2.warpAffine(outline,rotation,(390,110))>240
        points=cv2.transform(np.array([[[17,27],[230,27],[230,82],[17,82]]],dtype=np.float32),rotation)[0]
        result=estimate_text_alpha(image,points)
        self.assertIsNotNone(result)
        self.assertGreater(float(np.mean(result['alpha'][expected]>180)),.85)

    def test_thin_diacritics_and_punctuation_survive_a_large_source_line(self):
        rgb=np.full((160,2600,3),(130,55,75),np.uint8)
        for x in range(12,2500,110):
            cv2.putText(rgb,'HI',(x,99),cv2.FONT_HERSHEY_SIMPLEX,1.6,(250,250,250),2,cv2.LINE_AA)
            rgb[54,x+20]=[255,255,255]
        result=estimate_text_alpha(rgb,np.array([[5,45],[2580,45],[2580,110],[5,110]]))
        self.assertIsNotNone(result)
        self.assertEqual(result['alpha'].shape,rgb.shape[:2])
        self.assertGreater(sum(result['alpha'][54,x+20]>180 for x in range(12,2500,110)),20)

    def test_light_and_dark_letters_on_smooth_background_become_transparent(self):
        for foreground in [(250,250,250),(15,15,15)]:
            rgb=np.full((70,210,3),(160,60,75),np.uint8)
            cv2.putText(rgb,'ABC',(15,51),cv2.FONT_HERSHEY_SIMPLEX,1.5,foreground,3,cv2.LINE_AA)
            poly=np.array([[8,10],[200,10],[200,58],[8,58]])
            result=estimate_text_alpha(rgb,poly)
            self.assertIsNotNone(result)
            alpha=result['alpha']
            self.assertEqual(int(alpha[3,3]),0)
            self.assertEqual(int(alpha[30,180]),0)
            self.assertGreater(np.count_nonzero(alpha>200),300)
            self.assertLess(np.count_nonzero(alpha),rgb.shape[0]*rgb.shape[1]*.45)

    def test_smooth_gradient_is_supported_but_textured_ambiguous_crop_is_not_faked(self):
        xx=np.linspace(0,1,210)[None,:,None]
        gradient=np.repeat(((1-xx)*np.array([150,40,60])+xx*np.array([210,90,100])),70,axis=0).astype(np.uint8)
        cv2.putText(gradient,'TEXT',(10,49),cv2.FONT_HERSHEY_SIMPLEX,1.1,(250,250,250),2,cv2.LINE_AA)
        poly=np.array([[3,10],[205,10],[205,57],[3,57]])
        self.assertIsNotNone(estimate_text_alpha(gradient,poly))
        noisy=np.random.default_rng(44).integers(0,256,(70,210,3),dtype=np.uint8)
        self.assertIsNone(estimate_text_alpha(noisy,poly))

    def test_uniform_crop_is_not_reported_as_extracted_text(self):
        rgb=np.full((70,210,3),120,np.uint8)
        self.assertIsNone(estimate_text_alpha(rgb,np.array([[4,8],[200,8],[200,60],[4,60]])))

    def test_aligned_light_subtitles_can_be_separated_from_colored_texture(self):
        rgb=np.full((80,260,3),(165,35,55),np.uint8)
        for x in range(0,260,12):rgb[:,x:x+6]=(230,80,60)
        cv2.putText(rgb,'HELLO',(12,55),cv2.FONT_HERSHEY_SIMPLEX,1.4,(250,250,250),3,cv2.LINE_AA)
        result=estimate_text_alpha(rgb,np.array([[5,15],[245,15],[245,64],[5,64]]))
        self.assertIsNotNone(result)
        self.assertGreater(np.count_nonzero(result['alpha']>200),500)
        self.assertEqual(int(result['alpha'][30,235]),0)

    def test_interior_texture_with_smooth_padding_remains_an_explicit_crop(self):
        rgb=np.full((90,260,3),(170,80,110),np.uint8)
        for y in range(15,75,15):
            for x in range(15,245,16):rgb[y:y+3,x:x+4]=(35,25,40)
        cv2.putText(rgb,'TEXT',(55,58),cv2.FONT_HERSHEY_SIMPLEX,1.2,(250,250,250),2,cv2.LINE_AA)
        self.assertIsNone(estimate_text_alpha(rgb,np.array([[10,10],[250,10],[250,80],[10,80]])))

    def test_exported_text_alpha_removes_background_and_preserves_source_alpha(self):
        source=np.full((80,240,4),[160,50,65,128],np.uint8)
        rgb=source[:,:,:3].copy();cv2.putText(rgb,'TEXT',(14,54),cv2.FONT_HERSHEY_SIMPLEX,1.2,(250,250,250),3,cv2.LINE_AA);source[:,:,:3]=rgb
        with tempfile.TemporaryDirectory() as tmp:
            result=export_text(source,[[10,20],[130,20],[130,59],[10,59]],Path(tmp),'text_001')
            self.assertEqual(result['outputKind'],'mask')
            self.assertIn('mask',result)
            rgba=np.array(Image.open(Path(tmp)/result['file']))
            self.assertEqual(int(rgba[:,:,3].max()),128)
            self.assertGreater(float(np.mean(rgba[:,:,3]==0)),.5)


if __name__=='__main__':unittest.main()
