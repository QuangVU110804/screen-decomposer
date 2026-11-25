export function elementMatchesFilter(element,filter){
  const isText=element.type==='text-region'||element.type==='text';
  return filter==='all'||(filter==='text-region'?isText:!isText);
}
export function elementModeLabel(element){
  if(element.outputKind==='crop')return 'Crop · còn nền';
  if(element.type==='text-region'||element.type==='text')return 'Chữ · alpha';
  if(element.refinement?.multipart)return 'Graphic · nhiều phần';
  return 'PNG · có mask';
}
