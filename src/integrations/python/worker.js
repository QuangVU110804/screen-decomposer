'use strict';
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
function runWorker(config, request, { signal, onEvent = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Đã hủy tác vụ.'));
    const child = spawn(config.python, ['-u', config.workerPath || path.join(config.root, 'workers/engine.py')], {
      cwd: config.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    let buffer = '', diagnostics = '', result, failure, timer;
    let stage = 'boot';
    const stop = (error) => { failure ||= error; child.kill(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop(new Error(`Vượt thời gian xử lý (${stage}).`)), config.stageTimeoutMs); };
    const abort = () => stop(new Error('Đã hủy tác vụ.'));
    signal?.addEventListener('abort', abort, { once: true });
    arm();
    child.on('error', error => { failure = new Error(`Không chạy được Python local: ${error.message}`); });
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
    child.stdout.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 2 * 1024 * 1024) { stop(new Error('Worker trả message quá lớn.')); return; }
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'stage' && event.stage !== stage) { stage = event.stage; arm(); }
          if (event.type === 'result') result = event;
          else if (event.type === 'error') failure = new Error(event.message || 'Worker local bị lỗi.');
          else onEvent(event);
        } catch (error) { stop(new Error(`Worker protocol không hợp lệ: ${error.message}`)); }
      }
    });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Engine local kết thúc lỗi (${code}). ${diagnostics.slice(-800)}`));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
function engineStatus(config) {
  if (!fs.existsSync(config.python)) return Promise.resolve({ ready: false, segmentation: false, text: false, message: 'Chưa cài engine local. Chạy npm run setup:local.' });
  return new Promise(resolve => execFile(config.python, ['-u', path.join(config.root, 'workers/engine.py'), '--doctor', config.modelDir], {
    cwd: config.root, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' },
  }, (error, stdout) => {
    try { const data = JSON.parse(stdout); resolve(data); }
    catch { resolve({ ready: false, segmentation: false, text: false, message: error ? 'Engine chưa sẵn sàng. Chạy npm run setup:local.' : 'Không đọc được trạng thái engine.' }); }
  }));
}
module.exports = { runWorker, engineStatus };
