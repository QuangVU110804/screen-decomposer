'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const artifactStore = require('./artifactStore');
const {
  bestObservation,
  bboxToPixels,
  makeThumbnail,
} = require('./directExtractionService');

const SEGMENTABLE_TYPES = new Set(['person', 'character', 'graphic', 'object', 'overlay']);
let providerOverride = null;

function failedAsset(scene, element, assetId, code, message) {
  return {
    assetId,
    type: element.type,
    description: element.description,
    extractionMode: 'FAILED',
    attemptedExtractionMode: 'SEGMENTED',
    quality: 0,
    qualityState: 'failed',
    qualityComponents: {},
    sourcePixelsRatio: 0,
    reconstructedAreaRatio: 0,
    occurrences: [{ sceneId: scene.sceneId, elementId: element.elementId }],
    files: { primary: null, thumbnail: null, mask: null, rawMask: null, reconstructedMask: null },
    failure: { code, message },
  };
}

async function sha256File(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function providerCacheIdentity(options = {}) {
  const provider = options.provider || providerOverride;
  if (provider) {
    return [
      'custom',
      String(options.providerName || provider.name || 'provider'),
      String(options.providerVersion || provider.version || config.SEGMENTER_PROVIDER_VERSION),
    ].join(':');
  }
  if (config.SEGMENTER_ENDPOINT) {
    return `http:${config.SEGMENTER_PROVIDER_VERSION}:${config.SEGMENTER_ENDPOINT}`;
  }
  return 'local:local-border-matte:1';
}

async function copyCachedFile(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
}

function maskStats(alpha, width, height) {
  let foreground = 0;
  let soft = 0;
  let edgeForeground = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = alpha[y * width + x];
      if (value > 16) foreground++;
      if (value > 16 && value < 239) soft++;
      if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && value > 32) {
        edgeForeground++;
      }
    }
  }
  const pixels = Math.max(1, width * height);
  const perimeter = Math.max(1, width * 2 + height * 2 - 4);
  return {
    foregroundRatio: foreground / pixels,
    softAlphaRatio: soft / pixels,
    clippedBoundaryRatio: edgeForeground / perimeter,
  };
}

async function localSegment(cropBuffer, width, height) {
  const { data, info } = await sharp(cropBuffer, { failOn: 'none' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const samples = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
  for (let x = 0; x < width; x += step) {
    samples.push(yPixel(data, channels, width, x, 0), yPixel(data, channels, width, x, height - 1));
  }
  for (let y = step; y < height - step; y += step) {
    samples.push(yPixel(data, channels, width, 0, y), yPixel(data, channels, width, width - 1, y));
  }
  const background = [0, 1, 2].map((channel) => (
    samples.reduce((sum, sample) => sum + sample[channel], 0) / Math.max(1, samples.length)
  ));
  const deviations = samples.map((sample) => colorDistance(sample, background));
  const borderDeviation = deviations.reduce((sum, value) => sum + value, 0) / Math.max(1, deviations.length);
  const low = Math.max(12, borderDeviation * 1.4);
  const high = Math.max(low + 24, borderDeviation * 3 + 48);
  const raw = Buffer.alloc(width * height);
  for (let index = 0; index < width * height; index++) {
    const offset = index * channels;
    const distance = colorDistance(
      [data[offset], data[offset + Math.min(1, channels - 1)], data[offset + Math.min(2, channels - 1)]],
      background
    );
    raw[index] = Math.round(Math.max(0, Math.min(1, (distance - low) / (high - low))) * 255);
  }
  const refined = await sharp(raw, { raw: { width, height, channels: 1 } })
    .blur(0.8)
    .greyscale()
    .raw()
    .toBuffer();
  return {
    rawMask: raw,
    mask: refined,
    confidence: Math.max(0.2, Math.min(0.82, 0.82 - borderDeviation / 255)),
    provider: { name: 'local-border-matte', version: '1' },
  };
}

function yPixel(data, channels, width, x, y) {
  const offset = (y * width + x) * channels;
  return [
    data[offset],
    data[offset + Math.min(1, channels - 1)],
    data[offset + Math.min(2, channels - 1)],
  ];
}

function colorDistance(left, right) {
  return Math.sqrt(
    ((left[0] || 0) - (right[0] || 0)) ** 2 +
    ((left[1] || 0) - (right[1] || 0)) ** 2 +
    ((left[2] || 0) - (right[2] || 0)) ** 2
  );
}

async function endpointSegment(cropBuffer, width, height, element) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.SEGMENTER_TIMEOUT_MS);
  try {
    const response = await fetch(config.SEGMENTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.SEGMENTER_API_KEY ? { authorization: `Bearer ${config.SEGMENTER_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        imageBase64: cropBuffer.toString('base64'),
        mediaType: 'image/png',
        width,
        height,
        prompt: `${element.type}: ${element.description || ''}`,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`segmenter HTTP ${response.status}`);
    const body = await response.json();
    if (!body.maskBase64) throw new Error('segmenter response thiếu maskBase64');
    const maskPng = Buffer.from(body.maskBase64, 'base64');
    const mask = await sharp(maskPng, { failOn: 'none' })
      .resize(width, height, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();
    return {
      rawMask: mask,
      mask,
      confidence: Number(body.confidence || 0),
      provider: {
        name: String(body.provider || 'http-segmenter'),
        version: String(body.version || 'unknown'),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function segmentOne(jobId, scene, element, assetId, options = {}) {
  if (!SEGMENTABLE_TYPES.has(element.type) || element.extractability !== 'segmentable') return null;
  const selected = bestObservation(element, scene);
  if (!selected) return failedAsset(scene, element, assetId, 'NO_OBSERVATION', 'Không có observation hợp lệ để segment');
  const metadata = await sharp(selected.keyframe.path, { failOn: 'none' }).metadata();
  const crop = bboxToPixels(selected.observation.bbox, metadata.width, metadata.height, options.padding ?? 0.08);
  const cropBuffer = await sharp(selected.keyframe.path, { failOn: 'none' }).extract(crop).png().toBuffer();
  const outputDir = artifactStore.assetDir(jobId, scene.sceneId);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const primaryPath = path.join(outputDir, `${assetId}.png`);
  const thumbPath = path.join(outputDir, `${assetId}_thumb.jpg`);
  const maskPath = path.join(outputDir, `${assetId}_mask.png`);
  const rawMaskPath = path.join(outputDir, `${assetId}_mask_raw.png`);
  const providerName = options.provider || providerOverride
    ? 'custom'
    : (config.SEGMENTER_ENDPOINT ? 'http' : 'local');
  const providerIdentity = providerCacheIdentity(options);
  const cacheKey = crypto.createHash('sha256')
    .update(await sha256File(selected.keyframe.path))
    .update(JSON.stringify(crop))
    .update(`${element.type}:${element.description || ''}`)
    .update(providerIdentity)
    .digest('hex');
  const cacheRoot = path.join(artifactStore.cacheDir(jobId, scene.sceneId), 'segmentation', cacheKey);
  const cachePath = path.join(cacheRoot, 'metadata.json');
  const cacheFiles = {
    primary: path.join(cacheRoot, 'primary.png'),
    thumbnail: path.join(cacheRoot, 'thumbnail.jpg'),
    mask: path.join(cacheRoot, 'mask.png'),
    rawMask: path.join(cacheRoot, 'mask_raw.png'),
  };

  if (
    fs.existsSync(cachePath) &&
    Object.values(cacheFiles).every((filePath) => fs.existsSync(filePath))
  ) {
    try {
      const cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (cached.cacheKey === cacheKey) {
        await Promise.all([
          copyCachedFile(cacheFiles.primary, primaryPath),
          copyCachedFile(cacheFiles.thumbnail, thumbPath),
          copyCachedFile(cacheFiles.mask, maskPath),
          copyCachedFile(cacheFiles.rawMask, rawMaskPath),
        ]);
        return {
          ...cached.asset,
          assetId,
          segmentation: {
            ...cached.asset.segmentation,
            cacheHit: true,
          },
          files: { ...cached.asset.files, primary: primaryPath, thumbnail: thumbPath, mask: maskPath, rawMask: rawMaskPath },
        };
      }
    } catch (_error) {
      // Recompute a corrupt/incomplete cache entry.
    }
  }

  let result;
  let fallbackReason = null;
  try {
    if (options.provider || providerOverride) {
      const provider = options.provider || providerOverride;
      result = await provider.segment({ cropBuffer, width: crop.width, height: crop.height, element, scene });
    } else if (config.SEGMENTER_ENDPOINT) {
      result = await endpointSegment(cropBuffer, crop.width, crop.height, element);
    } else if (config.SEGMENTATION_LOCAL_FALLBACK) {
      result = await localSegment(cropBuffer, crop.width, crop.height);
    } else {
      throw new Error('Chưa cấu hình SEGMENTER_ENDPOINT và local fallback đang tắt');
    }
  } catch (error) {
    if (!config.SEGMENTATION_LOCAL_FALLBACK || (!config.SEGMENTER_ENDPOINT && !options.provider && !providerOverride)) {
      return failedAsset(scene, element, assetId, 'SEGMENTATION_FAILED', error.message);
    }
    fallbackReason = error.message;
    result = await localSegment(cropBuffer, crop.width, crop.height);
  }

  const mask = Buffer.isBuffer(result.mask)
    ? result.mask
    : await sharp(Buffer.from(result.maskBase64 || '', 'base64')).resize(crop.width, crop.height).grayscale().raw().toBuffer();
  const rawMask = Buffer.isBuffer(result.rawMask) ? result.rawMask : mask;
  const stats = maskStats(mask, crop.width, crop.height);
  if (stats.foregroundRatio < 0.01 || stats.foregroundRatio > 0.985) {
    return failedAsset(
      scene,
      element,
      assetId,
      'INVALID_MASK',
      `Mask không hữu ích (foregroundRatio=${stats.foregroundRatio.toFixed(3)})`
    );
  }

  const maskPng = await sharp(mask, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer();
  const rawMaskPng = await sharp(rawMask, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer();
  await fs.promises.writeFile(maskPath, maskPng);
  await fs.promises.writeFile(rawMaskPath, rawMaskPng);
  const rgb = await sharp(cropBuffer).removeAlpha().raw().toBuffer();
  await sharp(rgb, { raw: { width: crop.width, height: crop.height, channels: 3 } })
    .joinChannel(maskPng)
    .png()
    .toFile(primaryPath);
  await makeThumbnail(primaryPath, thumbPath, { checkerboard: true });

  const asset = {
    assetId,
    type: element.type,
    description: element.description,
    extractionMode: 'SEGMENTED',
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
      cropTransform: crop,
      originalResolution: [metadata.width, metadata.height],
    },
    segmentation: {
      confidence: Math.max(0, Math.min(1, Number(result.confidence || 0))),
      foregroundRatio: stats.foregroundRatio,
      softAlphaRatio: stats.softAlphaRatio,
      clippedBoundaryRatio: stats.clippedBoundaryRatio,
      edgeContamination: stats.clippedBoundaryRatio,
      provider: result.provider || { name: providerName, version: 'unknown' },
      fallbackReason,
      cacheHit: false,
    },
    width: crop.width,
    height: crop.height,
    occurrences: [{ sceneId: scene.sceneId, elementId: element.elementId }],
    files: { primary: primaryPath, thumbnail: thumbPath, mask: maskPath, rawMask: rawMaskPath, reconstructedMask: null },
  };
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  await Promise.all([
    copyCachedFile(primaryPath, cacheFiles.primary),
    copyCachedFile(thumbPath, cacheFiles.thumbnail),
    copyCachedFile(maskPath, cacheFiles.mask),
    copyCachedFile(rawMaskPath, cacheFiles.rawMask),
  ]);
  await artifactStore.writeJsonAtomic(cachePath, {
    cacheKey,
    providerIdentity,
    asset: {
      ...asset,
      files: {
        primary: null,
        thumbnail: null,
        mask: null,
        rawMask: null,
        reconstructedMask: null,
      },
    },
  });
  return asset;
}

async function segmentAssets(jobId, scenes, startIndex = 1, onProgress, options = {}) {
  const eligible = scenes.flatMap((scene) => (scene.elements || []).map((element) => ({ scene, element })))
    .filter(({ element }) => element.extractability === 'segmentable' && SEGMENTABLE_TYPES.has(element.type));
  const assets = [];
  const failures = [];
  const budget = options.maxCalls ?? config.MAX_SEGMENTATION_CALLS;
  for (let index = 0; index < eligible.length; index++) {
    const { scene, element } = eligible[index];
    const assetId = `asset_${String(startIndex + index).padStart(3, '0')}`;
    let asset;
    if (!config.ENABLE_SEGMENTATION) {
      asset = failedAsset(scene, element, assetId, 'SEGMENTATION_DISABLED', 'Segmentation đang tắt trong cấu hình');
    } else if (index >= budget) {
      asset = failedAsset(scene, element, assetId, 'SEGMENTATION_BUDGET_EXCEEDED', `Vượt budget ${budget} segmentation calls`);
    } else {
      try {
        asset = await segmentOne(jobId, scene, element, assetId, options);
      } catch (error) {
        asset = failedAsset(scene, element, assetId, 'SEGMENTATION_FAILED', error.message);
      }
    }
    if (asset) {
      assets.push(asset);
      element.assetIds.push(assetId);
      if (asset.extractionMode === 'FAILED') {
        failures.push({ sceneId: scene.sceneId, elementId: element.elementId, assetId, ...asset.failure });
      }
    }
    if (onProgress) onProgress(eligible.length ? (index + 1) / eligible.length : 1);
  }
  if (eligible.length === 0 && onProgress) onProgress(1);
  return { assets, failures, nextIndex: startIndex + eligible.length };
}

function setProviderForTests(provider) { providerOverride = provider; }
function resetProviderForTests() { providerOverride = null; }

module.exports = {
  SEGMENTABLE_TYPES,
  providerCacheIdentity,
  maskStats,
  localSegment,
  segmentOne,
  segmentAssets,
  setProviderForTests,
  resetProviderForTests,
};
