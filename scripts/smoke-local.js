'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { atomicJson } = require('../src/shared/files');
const base = process.env.IMAGE_TEST_URL || 'http://127.0.0.1:3000';
async function upload(input, preset = 'fast') {
  const body = new FormData(); body.append('file', new Blob([await fs.readFile(input)]), path.basename(input)); body.append('preset', preset);
  const response = await fetch(base + '/api/images', { method:'POST', body });
  assert.equal(response.status,202,await response.clone().text()); return response.json();
}
async function wait(id) {
  const start = Date.now(); let previous;
  while (Date.now()-start < 400000) {
    const response = await fetch(base + '/api/jobs/' + id); assert.equal(response.status,200);
    const job = await response.json();
    if(job.stage!==previous) { console.log(`Job ${id.slice(0,8)}: ${job.stage}`); previous=job.stage; }
    if(['done','partial','failed','canceled'].includes(job.status)) return job;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Smoke test timeout');
}
async function main() {
  const input = process.argv[2]; if(!input)throw new Error('Usage: node scripts/smoke-local.js <image>');
  const started=Date.now(); const job=await wait((await upload(input)).id);
  assert.equal(job.status,'done',JSON.stringify(job)); assert.ok(job.elements.length>0);
  const image = await fetch(base + job.elements[0].url); assert.equal(image.status,200);
  assert.deepEqual([...Buffer.from(await image.arrayBuffer()).subarray(0,4)],[137,80,78,71]);
  const response=await fetch(base+`/api/jobs/${job.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:job.elements.map(e=>e.id)})});
  assert.equal(response.status,200); const zip=Buffer.from(await response.arrayBuffer()); assert.equal(zip.subarray(0,2).toString(),'PK');
  const directory=path.resolve('test-results/images/http-smoke'); await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,job.id+'.zip'),zip);
  const cached=await wait((await upload(input)).id); assert.equal(cached.cacheHit,true);
  const cancelJob=await upload(input,'balanced');
  const canceled=await fetch(base+`/api/jobs/${cancelJob.id}/cancel`,{method:'POST'}); assert.equal(canceled.status,200);
  assert.equal((await wait(cancelJob.id)).status,'canceled');
  const report={jobId:job.id,cachedJobId:cached.id,canceledJobId:cancelJob.id,status:job.status,count:job.elements.length,zipBytes:zip.length,timings:job.timings,cachedTimings:cached.timings,wallMs:Date.now()-started};
  await atomicJson(path.join(directory,'report.json'),report); console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
