export function layerPoint(clientX,clientY,rect,scene,layer) {
  if(!rect.width||!rect.height)return null;
  const x=(clientX-rect.left)*scene.width/rect.width-(layer.placement?.x??layer.bbox[0]);
  const y=(clientY-rect.top)*scene.height/rect.height-(layer.placement?.y??layer.bbox[1]);
  if(x<0||y<0||x>=layer.bbox[2]||y>=layer.bbox[3])return null;
  return [Math.round(x*100)/100,Math.round(y*100)/100];
}
export const orderedLayers=elements=>elements.map((e,i)=>({e,i})).sort((a,b)=>(a.e.layerOrder??a.i)-(b.e.layerOrder??b.i)||a.i-b.i).map(v=>v.e);
export const initialLayerId=(elements,wanted)=>elements.find(e=>e.id===wanted)?.id??orderedLayers(elements).find(e=>e.layerVisible!==false)?.id??elements[0]?.id??null;

export class MaskHistory {
  constructor(limit=100,pointBudget=10000){this.limit=limit;this.pointBudget=pointBudget;this.items=[];this.cursor=0;}
  get operations(){return structuredClone(this.items.slice(0,this.cursor));}
  get canUndo(){return this.cursor>0;}
  get canRedo(){return this.cursor<this.items.length;}
  push(operation){
    const next=[...this.items.slice(0,this.cursor),structuredClone(operation)];
    if(next.length>this.limit||next.reduce((n,o)=>n+o.points.length,0)>this.pointBudget)throw new Error('Lưu mask trước khi tiếp tục: đã chạm giới hạn lịch sử.');
    this.items=next;this.cursor=next.length;
  }
  undo(){if(this.canUndo)this.cursor--;}
  redo(){if(this.canRedo)this.cursor++;}
  clear(){this.items=[];this.cursor=0;}
}
