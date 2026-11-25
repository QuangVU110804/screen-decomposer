'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
test('transparent text stays in text filter and distinct from image masks',async()=>{
  const {elementMatchesFilter,elementModeLabel}=await import('../../src/web/modules/element-types.mjs');
  const e={type:'text-region',outputKind:'mask'};
  assert.equal(elementMatchesFilter(e,'text-region'),true);
  assert.equal(elementMatchesFilter(e,'region'),false);
  assert.equal(elementModeLabel(e),'Chữ · alpha');
  assert.equal(elementModeLabel({type:'text-region',outputKind:'crop'}),'Crop · còn nền');
});
