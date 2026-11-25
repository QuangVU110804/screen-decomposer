'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runWorker } = require('../../src/integrations/python/worker');
const python = require('../../src/config/index').createConfig().python;
test('worker timeout and cancellation terminate process instead of hanging a job', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-'));
  const script = path.join(dir, 'hang.py');
  await fs.writeFile(script, 'import time\ntime.sleep(30)');
  const config = { root: dir, python, workerPath: script, stageTimeoutMs: 200 };
  try {
    await assert.rejects(runWorker(config, {}), /thời gian|timeout/i);
    const controller = new AbortController();
    const promise = runWorker({ ...config, stageTimeoutMs: 5000 }, {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, /hủy|cancel/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('worker protocol handles split JSON lines and bounded diagnostics', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-'));
  const script = path.join(dir, 'result.py');
  await fs.writeFile(script, 'import json,sys,time\nsys.stdin.readline()\nsys.stdout.write(\'{"type":"stage",\');sys.stdout.flush()\ntime.sleep(0.05)\nprint(\'"stage":"text"}\',flush=True)\nprint(json.dumps({"type":"result","elements":[],"warnings":[]} ),flush=True)');
  const events = [];
  try {
    const result = await runWorker({ root: dir, python, workerPath: script, stageTimeoutMs: 5000 }, {}, { onEvent: e => events.push(e) });
    assert.deepEqual(result.elements, []); assert.equal(events[0].stage, 'text');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
