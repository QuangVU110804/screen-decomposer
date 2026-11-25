'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const artifactStore = require('./artifactStore');
const { bestObservation, makeThumbnail } = require('./directExtractionService');

let providerOverride = null;

function providerCacheIdentity(options = {}) {
  const provider = options.provider || providerOverride;
  if (provider) {
    return [
      'custom',
      String(options.providerName || provider.name || 'provider'),
      String(options.providerVersion || provider.version || config.INPAINTER_PROVIDER_VERSION),
    ].join(':');
  }
  if (config.INPAINTER_ENDPOINT) {
    return `http:${config.INPAINTER_PROVIDER_VERSION}:${config.INPAINTER_ENDPOINT}`;
  }
  return 'local:local-blur-inpaint:1';
}

function recoveryCacheKey(imageBuffer, maskBuffer, element, options = {}) {
  return crypto.createHash('sha256')
    .update(imageBuffer)
    .update(maskBuffer)
    .update(`${element.type}:${element.description || ''}`)
    .update(providerCacheIdentity(options))
    .digest('hex');
}

function failedAsset(scene, element, assetId, code, message) {
  return {
    assetId,
    type: 'background',
    description: element.description,
    extractionMode: 'FAILED',
    attemptedExtractionMode: 'RECONSTRUCTED',
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

async function buildOcclusionMask(scene, assets, width, height) {
  const composites = [];
  for (const asset of assets) {
    if (asset.extractionMode !== 'SEGMENTED' || asset.source?.sceneId !== scene.sceneId || !asset.files?.mask) continue;
    if (!fs.existsSync(asset.files.mask) || !asset.source.cropTransform) continue;
    composites.push({
      input: await sharp(asset.files.mask).ensureAlpha().png().toBuffer(),
      left: asset.source.cropTransform.left,
      top: asset.source.cropTransform.top,
      blend: 'lighten',
    });
  }
  if (composites.length === 0) return null;
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .composite(composites)
    .removeAlpha()
    .grayscale()
    .png()
    .toBuffer();
}

async function endpointInpaint(imageBuffer, maskBuffer, width, height, element) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.INPAINTER_TIMEOUT_MS);
  try {
    const response = await fetch(config.INPAINTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.INPAINTER_API_KEY ? { authorization: `Bearer ${config.INPAINTER_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        imageBase64: imageBuffer.toString('base64'),
        maskBase64: maskBuffer.toString('base64'),
        mediaType: 'image/png',
        width,
        height,
        prompt: `Recover the background only. ${element.description || ''}`,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`inpainter HTTP ${response.status}`);
    const body = await response.json();
    if (!body.imageBase64) throw new Error('inpainter response thiếu imageBase64');
    return {
      image: Buffer.from(body.imageBase64, 'base64'),
      provider: { name: String(body.provider || 'http-inpainter'), version: String(body.version || 'unknown') },
      generated: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function localInpaint(imageBuffer, maskBuffer, width, height) {
  const blurred = await sharp(imageBuffer).blur(Math.max(8, Math.min(width, height) / 35)).png().toBuffer();
  const alpha = await sharp(maskBuffer).resize(width, height).grayscale().png().toBuffer();
  const blurredRaw = await sharp(blurred).removeAlpha().raw().toBuffer();
  const overlay = await sharp(blurredRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  return {
    image: await sharp(imageBuffer).composite([{ input: overlay, blend: 'over' }]).png().toBuffer(),
    provider: { name: 'local-blur-inpaint', version: '1' },
    generated: true,
  };
}

async function identityAlignmentScore(imageBuffer, alternativePath, maskBuffer, width, height) {
  const sampleWidth = Math.min(192, width);
  const sampleHeight = Math.max(1, Math.round(height * (sampleWidth / width)));
  const [reference, alternative, mask] = await Promise.all([
    sharp(imageBuffer).resize(sampleWidth, sampleHeight, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(alternativePath, { failOn: 'none' })
      .resize(sampleWidth, sampleHeight, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer(),
    sharp(maskBuffer).resize(sampleWidth, sampleHeight, { fit: 'fill' }).grayscale().raw().toBuffer(),
  ]);
  let difference = 0;
  let comparedPixels = 0;
  for (let index = 0; index < sampleWidth * sampleHeight; index++) {
    if (mask[index] > 32) continue;
    const offset = index * 3;
    difference += (
      Math.abs(reference[offset] - alternative[offset]) +
      Math.abs(reference[offset + 1] - alternative[offset + 1]) +
      Math.abs(reference[offset + 2] - alternative[offset + 2])
    ) / 3;
    comparedPixels++;
  }
  if (comparedPixels < sampleWidth * sampleHeight * 0.1) return null;
  return {
    method: 'identity-outside-recovery-mask',
    meanAbsoluteDifference: difference / comparedPixels,
    comparedPixels,
    sampleResolution: [sampleWidth, sampleHeight],
  };
}

async function temporalRecover(scene, selected, imageBuffer, maskBuffer, width, height, options = {}) {
  const averageMotion = (scene.keyframes || []).reduce(
    (sum, keyframe) => sum + Number(keyframe.motion || 0),
    0
  ) / Math.max(1, scene.keyframes?.length || 0);
  if (averageMotion > 0.35) return null;
  const alternatives = scene.keyframes
    .filter((keyframe) => keyframe.keyframeId !== selected.keyframe.keyframeId && keyframe.path && fs.existsSync(keyframe.path));
  if (alternatives.length === 0) return null;
  const maxAlignmentError = Number(options.maxTemporalAlignmentError ?? 18);
  let best = null;
  for (const alternative of alternatives) {
    const alternateMeta = await sharp(alternative.path, { failOn: 'none' }).metadata();
    if (alternateMeta.width !== width || alternateMeta.height !== height) continue;
    const alignment = await identityAlignmentScore(
      imageBuffer,
      alternative.path,
      maskBuffer,
      width,
      height
    );
    if (!alignment || alignment.meanAbsoluteDifference > maxAlignmentError) continue;
    if (!best || alignment.meanAbsoluteDifference < best.alignment.meanAbsoluteDifference) {
      best = { alternative, alignment };
    }
  }
  if (!best) return null;
  const alpha = await sharp(maskBuffer).resize(width, height).grayscale().png().toBuffer();
  const alternateRaw = await sharp(best.alternative.path).removeAlpha().raw().toBuffer();
  const overlay = await sharp(alternateRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  return {
    image: await sharp(imageBuffer).composite([{ input: overlay, blend: 'over' }]).png().toBuffer(),
    provider: { name: 'temporal-keyframe-recovery', version: '1' },
    generated: false,
    sourceKeyframeId: best.alternative.keyframeId,
    alignment: {
      ...best.alignment,
      meanAbsoluteDifference: Number(best.alignment.meanAbsoluteDifference.toFixed(4)),
    },
  };
}

async function recoverOne(jobId, scene, element, assets, assetId, options = {}) {
  const selected = bestObservation(element, scene);
  if (!selected) return failedAsset(scene, element, assetId, 'NO_OBSERVATION', 'Không có background observation hợp lệ');
  const metadata = await sharp(selected.keyframe.path, { failOn: 'none' }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const imageBuffer = await sharp(selected.keyframe.path).png().toBuffer();
  const maskBuffer = await buildOcclusionMask(scene, assets, width, height);
  if (!maskBuffer) {
    return failedAsset(scene, element, assetId, 'NO_FOREGROUND_MASK', 'Không có foreground mask để xác định vùng nền bị che');
  }
  const stats = await sharp(maskBuffer).stats();
  const missingRatio = Number(stats.channels[0].mean || 0) / 255;
  if (missingRatio <= 0.001) {
    return failedAsset(scene, element, assetId, 'EMPTY_RECOVERY_MASK', 'Recovery mask rỗng');
  }
  const maxRatio = options.maxAreaRatio ?? config.MAX_INPAINT_AREA_RATIO;
  if (missingRatio > maxRatio) {
    return failedAsset(
      scene,
      element,
      assetId,
      'RECOVERY_AREA_TOO_LARGE',
      `Vùng cần phục hồi ${(missingRatio * 100).toFixed(1)}% vượt ngưỡng ${(maxRatio * 100).toFixed(1)}%`
    );
  }

  let result = await temporalRecover(scene, selected, imageBuffer, maskBuffer, width, height, options);
  let fallbackReason = null;
  let cacheHit = false;
  if (!result) {
    const cacheKey = recoveryCacheKey(imageBuffer, maskBuffer, element, options);
    const cacheRoot = path.join(artifactStore.cacheDir(jobId, scene.sceneId), 'inpainting', cacheKey);
    const cachePath = path.join(cacheRoot, 'metadata.json');
    const cacheImagePath = path.join(cacheRoot, 'reconstructed.png');
    if (fs.existsSync(cachePath) && fs.existsSync(cacheImagePath)) {
      try {
        const cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
        if (cached.cacheKey === cacheKey) {
          result = {
            image: await fs.promises.readFile(cacheImagePath),
            provider: cached.provider,
            generated: Boolean(cached.generated),
          };
          fallbackReason = cached.fallbackReason || null;
          cacheHit = true;
        }
      } catch (_error) {
        // Recompute corrupt or incomplete cache entries.
      }
    }
    try {
      if (!result) {
        if (options.provider || providerOverride) {
          const provider = options.provider || providerOverride;
          result = await provider.inpaint({ imageBuffer, maskBuffer, width, height, element, scene });
        } else if (config.INPAINTER_ENDPOINT) {
          result = await endpointInpaint(imageBuffer, maskBuffer, width, height, element);
        } else if (config.INPAINTER_LOCAL_FALLBACK) {
          result = await localInpaint(imageBuffer, maskBuffer, width, height);
        } else {
          throw new Error('Chưa cấu hình INPAINTER_ENDPOINT và local fallback đang tắt');
        }
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        await sharp(result.image).png().toFile(cacheImagePath);
        await artifactStore.writeJsonAtomic(cachePath, {
          cacheKey,
          providerIdentity: providerCacheIdentity(options),
          provider: result.provider,
          generated: Boolean(result.generated),
          fallbackReason: null,
        });
      }
    } catch (error) {
      if (!config.INPAINTER_LOCAL_FALLBACK) {
        return failedAsset(scene, element, assetId, 'BACKGROUND_RECOVERY_FAILED', error.message);
      }
      fallbackReason = error.message;
      result = await localInpaint(imageBuffer, maskBuffer, width, height);
    }
  }

  const outputDir = artifactStore.assetDir(jobId, scene.sceneId);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const primaryPath = path.join(outputDir, `${assetId}.png`);
  const thumbPath = path.join(outputDir, `${assetId}_thumb.jpg`);
  const recoveryMaskPath = path.join(outputDir, `${assetId}_reconstructed_mask.png`);
  await sharp(result.image).png().toFile(primaryPath);
  await sharp(maskBuffer).png().toFile(recoveryMaskPath);
  await makeThumbnail(primaryPath, thumbPath);
  return {
    assetId,
    type: 'background',
    description: element.description,
    extractionMode: 'RECONSTRUCTED',
    quality: 0,
    qualityState: 'review',
    qualityComponents: {},
    sourcePixelsRatio: result.generated ? Math.max(0, 1 - missingRatio) : 1,
    reconstructedAreaRatio: result.generated ? missingRatio : 0,
    recoveryAreaRatio: missingRatio,
    source: {
      sceneId: scene.sceneId,
      elementId: element.elementId,
      trackId: element.trackId || null,
      keyframeId: selected.keyframe.keyframeId,
      timestamp: selected.keyframe.timestamp,
      bbox: selected.observation.bbox,
      originalResolution: [width, height],
    },
    reconstruction: {
      provider: result.provider,
      generated: Boolean(result.generated),
      temporalSourceKeyframeId: result.sourceKeyframeId || null,
      alignment: result.alignment || null,
      fallbackReason,
      artifactScore: result.generated ? Math.min(1, missingRatio * 1.8) : 0.15,
      cacheHit,
    },
    width,
    height,
    occurrences: [{ sceneId: scene.sceneId, elementId: element.elementId }],
    files: { primary: primaryPath, thumbnail: thumbPath, mask: null, rawMask: null, reconstructedMask: recoveryMaskPath },
  };
}

async function recoverBackgrounds(jobId, scenes, existingAssets, startIndex = 1, onProgress, options = {}) {
  const eligible = scenes.flatMap((scene) => (scene.elements || []).map((element) => ({ scene, element })))
    .filter(({ element }) => element.type === 'background' && element.extractability === 'requires_inpainting');
  if (!config.ENABLE_BACKGROUND_RECOVERY) {
    if (onProgress) onProgress(1);
    return {
      assets: [],
      failures: [],
      skipped: eligible.map(({ scene, element }) => ({
        sceneId: scene.sceneId,
        elementId: element.elementId,
        code: 'BACKGROUND_RECOVERY_DISABLED',
      })),
      nextIndex: startIndex,
    };
  }
  const assets = [];
  const failures = [];
  for (let index = 0; index < eligible.length; index++) {
    const { scene, element } = eligible[index];
    const assetId = `asset_${String(startIndex + index).padStart(3, '0')}`;
    let asset;
    try {
      asset = await recoverOne(jobId, scene, element, existingAssets, assetId, options);
    } catch (error) {
      asset = failedAsset(scene, element, assetId, 'BACKGROUND_RECOVERY_FAILED', error.message);
    }
    assets.push(asset);
    element.assetIds.push(assetId);
    if (asset.extractionMode === 'FAILED') {
      failures.push({ sceneId: scene.sceneId, elementId: element.elementId, assetId, ...asset.failure });
    }
    if (onProgress) onProgress(eligible.length ? (index + 1) / eligible.length : 1);
  }
  if (eligible.length === 0 && onProgress) onProgress(1);
  return { assets, failures, nextIndex: startIndex + eligible.length };
}

function setProviderForTests(provider) { providerOverride = provider; }
function resetProviderForTests() { providerOverride = null; }

module.exports = {
  buildOcclusionMask,
  providerCacheIdentity,
  recoveryCacheKey,
  localInpaint,
  identityAlignmentScore,
  temporalRecover,
  recoverOne,
  recoverBackgrounds,
  setProviderForTests,
  resetProviderForTests,
};
