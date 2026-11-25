const test=require('node:test');
const assert=require('node:assert/strict');

test('reverse drags produce bounded native-pixel rectangles, empty drags produce no region',async()=>{
  const {rectangleFromPoints}=await import('../../src/web/modules/watermark-selection.mjs');
  assert.deepEqual(rectangleFromPoints([70.8,50.2],[10.1,8.7],100,80),[10,8,61,43]);
  assert.deepEqual(rectangleFromPoints([-10,-4],[120,90],100,80),[0,0,100,80]);
  assert.equal(rectangleFromPoints([10,10],[10,10],100,80),null);
  assert.equal(rectangleFromPoints([120,90],[140,100],100,80),null);
});
