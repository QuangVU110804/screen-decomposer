'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('editor maps zoomed canvas coordinates into native layer pixels without moving other layers',async()=>{
  const {layerPoint}=await import('../../src/web/modules/layer-state.mjs');
  const rect={left:20,top:30,width:600,height:338};
  const scene={width:1200,height:676};
  const layer={bbox:[100,50,200,300],placement:{x:300,y:150}};
  assert.deepEqual(layerPoint(220,155,rect,scene,layer),[100,100]);
  assert.equal(layerPoint(25,35,rect,scene,layer),null);
});
test('mask undo and redo retain exact native stroke coordinates and discard an abandoned redo branch',async()=>{
  const {MaskHistory}=await import('../../src/web/modules/layer-state.mjs');
  const history=new MaskHistory(4,10);
  const stroke={kind:'brush',mode:'erase',radius:7,points:[[2,3],[4,5]]};
  history.push(stroke);stroke.points[0][0]=999;
  history.push({kind:'polygon',mode:'add',points:[[10,10],[20,10],[20,20]]});
  history.undo();assert.deepEqual(history.operations,[{kind:'brush',mode:'erase',radius:7,points:[[2,3],[4,5]]}]);
  history.redo();assert.equal(history.operations.length,2);
  history.undo();history.push({kind:'brush',mode:'add',radius:2,points:[[1,1]]});
  assert.equal(history.canRedo,false);assert.equal(history.operations[1].kind,'brush');
});
test('mask history enforces server point budget before mutating undo state',async()=>{
  const {MaskHistory}=await import('../../src/web/modules/layer-state.mjs');
  const h=new MaskHistory(2,3);
  h.push({kind:'brush',mode:'add',radius:3,points:[[1,1],[2,2]]});
  assert.throws(()=>h.push({kind:'brush',mode:'erase',radius:3,points:[[1,1],[2,2]]}),/Lưu/);
  assert.equal(h.operations.length,1);
});
test('layer ordering is stable and visibility is independent from export selection',async()=>{
  const {orderedLayers}=await import('../../src/web/modules/layer-state.mjs');
  const b={id:'b',layerOrder:0,selected:true,layerVisible:false};
  const a={id:'a',layerOrder:2};const c={id:'c',layerOrder:2};
  assert.deepEqual(orderedLayers([a,b,c]).map(x=>x.id),['b','a','c']);
  assert.equal(b.selected,true);
});
test('editor initially selects a visible layer while honoring an explicitly requested element',async()=>{
  const {initialLayerId}=await import('../../src/web/modules/layer-state.mjs');
  const elements=[{id:'hidden',layerVisible:false},{id:'visible',layerVisible:true},{id:'last'}];
  assert.equal(initialLayerId(elements),'visible');
  assert.equal(initialLayerId(elements,'hidden'),'hidden');
  assert.equal(initialLayerId(elements,'missing'),'visible');
  assert.equal(initialLayerId([]),null);
});
