'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeImage } = require('../images/normalize');
const { runWorker } = require('../../integrations/python/worker');

const invalid = message => Object.assign(new Error(message), {status:400});
function validateRegions(regions, width, height) {
  if (!Array.isArray(regions) || !regions.length || regions.length > 20) throw invalid('Hãy chọn từ 1 đến 20 vùng watermark/logo.');
  let area = 0;
  for (const box of regions) {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isSafeInteger)) throw invalid('Tọa độ vùng xóa phải là số nguyên pixel.');
    const [x,y,w,h] = box;
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) throw invalid('Vùng xóa phải nằm trong ảnh và có kích thước lớn hơn 0.');
    area += w * h;
  }
  if (area > Math.min(width * height * 0.2, 1_000_000)) throw invalid('Tổng diện tích các khung xóa tối đa 20% ảnh và 1 triệu pixel. Hãy khoanh sát watermark/logo.');
}

function createWatermarkRoutes({config, worker = runWorker}) {
  const router = express.Router();
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:config.maxBytes,files:1,fields:1,parts:3,fieldSize:8192}}).single('file');
  let active, closing = false;
  const processImage = detect => async (req,res,next) => {
    if (closing || active) return res.status(429).json({error:'Công cụ watermark đang bận. Hãy chờ rồi thử lại.'});
    const controller = new AbortController();
    let finished;
    const current = {controller, done:new Promise(resolve => { finished = resolve; })};
    active = current;
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    let dir, result, failure;
    try {
      await new Promise((resolve,reject) => {
        const abortUpload = () => { req.destroy(); reject(invalid('Đã hủy upload.')); };
        controller.signal.addEventListener('abort',abortUpload,{once:true});
        upload(req,res,error => {
          controller.signal.removeEventListener('abort',abortUpload);
          if (error) reject(error); else resolve();
        });
      });
      if (!req.file) throw invalid('Hãy chọn một ảnh JPG, PNG hoặc WebP tĩnh.');
      let regions;
      if (!detect) {
        try { regions = JSON.parse(req.body.regions); } catch { throw invalid('Danh sách vùng xóa không hợp lệ.'); }
        validateRegions(regions, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      }
      if (controller.signal.aborted || req.aborted) throw invalid('Upload đã ngắt kết nối.');
      const root = path.join(config.dataDir,'watermark');
      await fs.mkdir(root,{recursive:true});
      dir = await fs.mkdtemp(path.join(root,'request-'));
      const source = await normalizeImage(req.file.buffer,dir,config,{preview:false});
      const output = path.join(dir,'cleaned.png');
      if (!detect) validateRegions(regions,source.width,source.height);
      const value = await worker({...config,workerPath:path.join(config.root,'workers/watermark.py'),stageTimeoutMs:60_000},
        detect ? {source:source.source,action:'detect'} : {source:source.source,output,regions}, {signal:controller.signal});
      if (controller.signal.aborted) throw invalid('Đã hủy tác vụ.');
      result = detect ? {width:source.width,height:source.height,suggestions:value.suggestions,warnings:value.warnings} : await fs.readFile(output);
    } catch (error) { failure = error; }
    finally {
      if (dir) {
        try { await fs.rm(dir,{recursive:true,force:true}); }
        catch { failure ||= new Error('Không dọn được tệp tạm. Hãy kiểm tra quyền thư mục dữ liệu.'); }
      }
      res.removeListener('close',disconnect);
      if (active === current) active = undefined;
      finished();
    }
    if (res.destroyed) return;
    if (failure) return next(failure);
    if (detect) return res.set('Cache-Control','no-store').json(result);
    res.set({'Content-Type':'image/png','Content-Disposition':'attachment; filename="cleaned.png"','Cache-Control':'no-store'}).send(result);
  };
  router.post('/detect', processImage(true));
  router.post('/remove', processImage(false));
  router.close = async () => { closing = true; const current = active; current?.controller.abort(); await current?.done; };
  return router;
}
module.exports = { createWatermarkRoutes, validateRegions };
