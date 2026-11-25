'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const artifactStore = require('./artifactStore');
const ocrService = require('./ocrService');

const DIRECT_TYPES = new Set(['image', 'screenshot', 'text', 'graphic', 'logo', 'overlay']);

function failedAsset(scene, element, assetId, code, message) {
  const observation = element.observations?.[0] || null;
  return {
    assetId,
    type: element.type,
    description: element.description,
    extractionMode: 'FAILED',
    attemptedExtractionMode: 'DIRECT',
    quality: 0,
    qualityState: 'failed',
    qualityComponents: {},
    sourcePixelsRatio: 0,
    reconstructedAreaRatio: 0,
    source: observation ? {
      sceneId: scene.sceneId,
      elementId: element.elementId,
      trackId: element.trackId || null,
      keyframeId: observation.keyframeId,
      bbox: observation.bbox,
    } : null,
    occurrences: [{ sceneId: scene.sceneId, elementId: element.elementId }],
    files: {
      primary: null,
      thumbnail: null,
      mask: null,
      rawMask: null,
      reconstructedMask: null,
    },
    failure: { code, message },
  };
}

function bestObservation(element, scene) {
  const keyframes = new Map(scene.keyframes.map((item) => [item.keyframeId, item]));
  return [...element.observations]
    .map((observation) => ({ observation, keyframe: keyframes.get(observation.keyframeId) }))
    .filter((item) => item.keyframe?.path)
    .sort((left, right) => {
      const score = (item) => {
        const area = item.observation.bbox[2] * item.observation.bbox[3];
        return item.observation.visibility * (1 - item.observation.occlusion) * Math.sqrt(area) *
          Math.log2(2 + Number(item.keyframe.sharpness || 0));
      };
      return score(right) - score(left);
    })[0] || null;
}

function bboxToPixels(bbox, width, height, padding = config.DIRECT_CROP_PADDING) {
  const [x, y, boxWidth, boxHeight] = bbox;
  const padX = boxWidth * padding;
  const padY = boxHeight * padding;
  const left = Math.max(0, Math.floor((x - padX) * width));
  const top = Math.max(0, Math.floor((y - padY) * height));
  const right = Math.min(width, Math.ceil((x + boxWidth + padX) * width));
  const bottom = Math.min(height, Math.ceil((y + boxHeight + padY) * height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function pointDistance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

async function rectifyQuadrilateral(filePath, corners) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const points = corners.map(([x, y]) => [
    x * Math.max(1, info.width - 1),
    y * Math.max(1, info.height - 1),
  ]);
  const outputWidth = Math.max(1, Math.round(Math.max(
    pointDistance(points[0], points[1]),
    pointDistance(points[3], points[2])
  )));
  const outputHeight = Math.max(1, Math.round(Math.max(
    pointDistance(points[0], points[3]),
    pointDistance(points[1], points[2])
  )));
  const output = Buffer.alloc(outputWidth * outputHeight * 3);
  for (let y = 0; y < outputHeight; y++) {
    const v = outputHeight === 1 ? 0 : y / (outputHeight - 1);
    for (let x = 0; x < outputWidth; x++) {
      const u = outputWidth === 1 ? 0 : x / (outputWidth - 1);
      const sourceX =
        (1 - u) * (1 - v) * points[0][0] +
        u * (1 - v) * points[1][0] +
        u * v * points[2][0] +
        (1 - u) * v * points[3][0];
      const sourceY =
        (1 - u) * (1 - v) * points[0][1] +
        u * (1 - v) * points[1][1] +
        u * v * points[2][1] +
        (1 - u) * v * points[3][1];
      const nearestX = Math.max(0, Math.min(info.width - 1, Math.round(sourceX)));
      const nearestY = Math.max(0, Math.min(info.height - 1, Math.round(sourceY)));
      const sourceOffset = (nearestY * info.width + nearestX) * info.channels;
      const targetOffset = (y * outputWidth + x) * 3;
      output[targetOffset] = data[sourceOffset];
      output[targetOffset + 1] = data[sourceOffset + Math.min(1, info.channels - 1)];
      output[targetOffset + 2] = data[sourceOffset + Math.min(2, info.channels - 1)];
    }
  }
  return {
    buffer: await sharp(output, { raw: { width: outputWidth, height: outputHeight, channels: 3 } }).png().toBuffer(),
    width: outputWidth,
    height: outputHeight,
    transform: {
      type: 'quadrilateral_rectification',
      corners,
      outputResolution: [outputWidth, outputHeight],
    },
  };
}

async function makeThumbnail(primaryPath, thumbPath, { checkerboard = false } = {}) {
  let pipeline = sharp(primaryPath, { failOn: 'none' }).resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true });
  if (checkerboard) {
    const foreground = await sharp(primaryPath, { failOn: 'none' })
      .resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const background = {
      create: {
        width: foreground.info.width,
        height: foreground.info.height,
        channels: 3,
        background: '#d7dbe2',
      },
    };
    pipeline = sharp(background).composite([{ input: foreground.data }]);
  }
  await pipeline.jpeg({ quality: 82 }).toFile(thumbPath);
}

async function extractDirectAsset(jobId, scene, element, assetId, options = {}) {
  if (!DIRECT_TYPES.has(element.type) || element.extractability !== 'direct') return null;
  const selected = bestObservation(element, scene);
  if (!selected) return null;
  const metadata = await sharp(selected.keyframe.path, { failOn: 'none' }).metadata();
  const crop = bboxToPixels(selected.observation.bbox, metadata.width, metadata.height, options.padding);
  const outputDir = artifactStore.assetDir(jobId, scene.sceneId);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const primaryPath = path.join(outputDir, `${assetId}.png`);
  const thumbPath = path.join(outputDir, `${assetId}_thumb.jpg`);
  let cropTransform = crop;
  if (selected.observation.corners) {
    const rectified = await rectifyQuadrilateral(selected.keyframe.path, selected.observation.corners);
    await fs.promises.writeFile(primaryPath, rectified.buffer);
    cropTransform = rectified.transform;
  } else {
    await sharp(selected.keyframe.path, { failOn: 'none' }).extract(crop).png().toFile(primaryPath);
  }
  await makeThumbnail(primaryPath, thumbPath);
  const output = await sharp(primaryPath).metadata();
  const ocr = element.type === 'text'
    ? await ocrService.recognizeElement(element, {
      sceneId: scene.sceneId,
      keyframeId: selected.keyframe.keyframeId,
      imagePath: primaryPath,
    }, options.ocr || {})
    : null;
  return {
    assetId,
    type: element.type,
    description: element.description,
    extractionMode: 'DIRECT',
    quality: 0,
    qualityState: 'review',
    qualityComponents: {},
    sourcePixelsRatio: 1,
    reconstructedAreaRatio: 0,
    source: {
      sceneId: scene.sceneId,
      elementId: element.elementId,
      trackId: element.trackId || null,
      keyframeId: selected.keyframe.keyframeId,
      timestamp: selected.keyframe.timestamp,
      bbox: selected.observation.bbox,
      cropTransform,
      originalResolution: [metadata.width, metadata.height],
    },
    text: ocr,
    width: output.width,
    height: output.height,
    occurrences: [{ sceneId: scene.sceneId, elementId: element.elementId }],
    files: { primary: primaryPath, thumbnail: thumbPath, mask: null, reconstructedMask: null },
  };
}

async function extractDirectAssets(jobId, scenes, startIndex = 1, onProgress, options = {}) {
  const eligible = scenes.flatMap((scene) => (scene.elements || []).map((element) => ({ scene, element })))
    .filter(({ element }) => element.extractability === 'direct' && DIRECT_TYPES.has(element.type));
  const assets = [];
  const failures = [];
  for (let index = 0; index < eligible.length; index++) {
    const { scene, element } = eligible[index];
    const assetId = `asset_${String(startIndex + index).padStart(3, '0')}`;
    try {
      const asset = await extractDirectAsset(jobId, scene, element, assetId, options);
      if (asset) {
        assets.push(asset);
        element.assetIds.push(assetId);
      }
    } catch (error) {
      const asset = failedAsset(
        scene,
        element,
        assetId,
        'DIRECT_EXTRACTION_FAILED',
        error.message
      );
      assets.push(asset);
      element.assetIds.push(assetId);
      failures.push({
        sceneId: scene.sceneId,
        elementId: element.elementId,
        assetId,
        ...asset.failure,
      });
    }
    if (onProgress) onProgress(eligible.length ? (index + 1) / eligible.length : 1);
  }
  if (eligible.length === 0 && onProgress) onProgress(1);
  return { assets, failures, nextIndex: startIndex + eligible.length };
}

module.exports = {
  DIRECT_TYPES,
  failedAsset,
  bestObservation,
  bboxToPixels,
  rectifyQuadrilateral,
  makeThumbnail,
  extractDirectAsset,
  extractDirectAssets,
};
