'use strict';

const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function sourceContext(asset, scenes) {
  const scene = scenes.find((item) => item.sceneId === asset.source?.sceneId);
  const element = scene?.elements?.find((item) => item.elementId === asset.source?.elementId);
  const observation = element?.observations?.find((item) => item.keyframeId === asset.source?.keyframeId)
    || element?.observations?.[0];
  const keyframe = scene?.keyframes?.find((item) => item.keyframeId === asset.source?.keyframeId);
  return { scene, element, observation, keyframe };
}

function weightedScore(components, weights) {
  let total = 0;
  let weight = 0;
  for (const [key, value] of Object.entries(weights)) {
    total += clamp01(components[key]) * value;
    weight += value;
  }
  return weight > 0 ? total / weight : 0;
}

function weightsFor(asset) {
  if (asset.extractionMode === 'SEGMENTED') {
    return {
      resolution: 1.1, sharpness: 1, visibility: 1.2, occlusion: 1.2,
      semantic: 0.7, localization: 1, mask: 1.8, provenance: 0.7,
    };
  }
  if (asset.extractionMode === 'RECONSTRUCTED') {
    return {
      resolution: 1, sharpness: 0.7, visibility: 0.8, occlusion: 0.7,
      semantic: 0.7, localization: 0.7, reconstruction: 2, provenance: 1.2,
    };
  }
  if (asset.type === 'text') {
    return {
      resolution: 1.3, sharpness: 1.5, visibility: 1, occlusion: 0.7,
      semantic: 1.2, localization: 1, provenance: 0.8,
    };
  }
  return {
    resolution: 1.4, sharpness: 1, visibility: 1, occlusion: 0.8,
    semantic: 0.8, localization: 1, provenance: 1,
  };
}

function scoreAsset(asset, scenes) {
  if (asset.extractionMode === 'FAILED') {
    asset.quality = 0;
    asset.qualityState = 'failed';
    asset.qualityComponents = { failure: 1 };
    return asset;
  }
  const { element, observation, keyframe } = sourceContext(asset, scenes);
  const pixels = Math.max(0, Number(asset.width || 0) * Number(asset.height || 0));
  const reconstructionRatio = clamp01(asset.reconstructedAreaRatio);
  const artifactScore = clamp01(asset.reconstruction?.artifactScore);
  const components = {
    resolution: clamp01(Math.log2(1 + pixels) / Math.log2(1 + 1280 * 720)),
    sharpness: clamp01(Number(keyframe?.sharpness || 0) / (Number(keyframe?.sharpness || 0) + 180)),
    visibility: clamp01(observation?.visibility ?? 0.5),
    occlusion: 1 - clamp01(observation?.occlusion ?? 0.5),
    semantic: clamp01(element?.semanticConfidence ?? 0.5),
    localization: clamp01(element?.localizationConfidence ?? 0.5),
    mask: asset.extractionMode === 'SEGMENTED'
      ? clamp01(
        Number(asset.segmentation?.confidence || 0) *
        (1 - clamp01(asset.segmentation?.edgeContamination)) *
        (1 - clamp01(asset.segmentation?.clippedBoundaryRatio) * 0.6)
      )
      : 1,
    reconstruction: asset.extractionMode === 'RECONSTRUCTED'
      ? clamp01(1 - reconstructionRatio * 1.25 - artifactScore * 0.65)
      : 1,
    provenance: asset.extractionMode === 'DIRECT'
      ? (Number(asset.sourcePixelsRatio) === 1 ? 1 : 0)
      : clamp01(Number(asset.sourcePixelsRatio || 0) + 0.25),
  };
  const score = clamp01(weightedScore(components, weightsFor(asset)));
  asset.qualityComponents = Object.fromEntries(
    Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(4))])
  );
  asset.quality = Number(score.toFixed(4));
  asset.qualityState = score >= config.ASSET_REVIEW_QUALITY
    ? 'usable'
    : (score >= config.ASSET_MIN_QUALITY ? 'review' : 'failed');
  return asset;
}

async function validateAssetFile(asset) {
  if (asset.extractionMode === 'FAILED') return { valid: true, diagnosticOnly: true };
  const primary = asset.files?.primary;
  if (!primary || !fs.existsSync(primary)) return { valid: false, code: 'PRIMARY_FILE_MISSING', message: 'Thiếu file primary' };
  let metadata;
  let stats;
  try {
    metadata = await sharp(primary, { failOn: 'error' }).metadata();
    stats = await sharp(primary, { failOn: 'error' }).stats();
  } catch (error) {
    return { valid: false, code: 'CORRUPT_ASSET_FILE', message: error.message };
  }
  if (!metadata.width || !metadata.height || metadata.width < 8 || metadata.height < 8) {
    return { valid: false, code: 'ASSET_TOO_SMALL', message: 'Asset có kích thước không hợp lệ' };
  }
  if (asset.width && (asset.width !== metadata.width || asset.height !== metadata.height)) {
    return { valid: false, code: 'DIMENSION_MISMATCH', message: 'Metadata kích thước không khớp file' };
  }
  if (asset.extractionMode === 'DIRECT' && Number(asset.sourcePixelsRatio) !== 1) {
    return { valid: false, code: 'DIRECT_PROVENANCE_INVALID', message: 'DIRECT asset phải có sourcePixelsRatio = 1' };
  }
  if (asset.extractionMode === 'SEGMENTED') {
    if (!metadata.hasAlpha || stats.channels.length < 4) {
      return { valid: false, code: 'SEGMENTED_ALPHA_MISSING', message: 'SEGMENTED asset không có alpha channel' };
    }
    const alpha = stats.channels[stats.channels.length - 1];
    if (alpha.min >= 250 || alpha.max <= 5) {
      return { valid: false, code: 'SEGMENTED_ALPHA_EMPTY', message: 'Alpha channel không chứa cả foreground và transparency' };
    }
    if (!asset.files?.mask || !fs.existsSync(asset.files.mask)) {
      return { valid: false, code: 'SEGMENTED_MASK_MISSING', message: 'Thiếu segmentation mask' };
    }
  }
  if (asset.extractionMode === 'RECONSTRUCTED') {
    if (!asset.reconstruction?.provider?.name) {
      return { valid: false, code: 'RECONSTRUCTION_PROVIDER_MISSING', message: 'Thiếu provider metadata' };
    }
    if ((Number(asset.reconstructedAreaRatio || 0) > 0 || Number(asset.recoveryAreaRatio || 0) > 0) &&
        (!asset.files?.reconstructedMask || !fs.existsSync(asset.files.reconstructedMask))) {
      return { valid: false, code: 'RECONSTRUCTION_MASK_MISSING', message: 'Thiếu reconstruction mask' };
    }
  }
  return { valid: true, metadata };
}

function failValidation(asset, result) {
  asset.attemptedExtractionMode = asset.extractionMode;
  asset.extractionMode = 'FAILED';
  asset.quality = 0;
  asset.qualityState = 'failed';
  asset.sourcePixelsRatio = 0;
  asset.reconstructedAreaRatio = 0;
  asset.failure = { code: result.code, message: result.message };
  return asset;
}

async function scoreAndValidateAssets(assets, scenes, onProgress) {
  const failures = [];
  for (let index = 0; index < assets.length; index++) {
    const asset = scoreAsset(assets[index], scenes);
    const validation = await validateAssetFile(asset);
    asset.validation = {
      valid: validation.valid,
      checkedAt: new Date().toISOString(),
      ...(validation.code ? { code: validation.code } : {}),
    };
    if (!validation.valid) {
      failValidation(asset, validation);
      failures.push({ assetId: asset.assetId, code: validation.code, message: validation.message });
    } else if (asset.qualityState === 'failed') {
      failures.push({ assetId: asset.assetId, code: 'QUALITY_BELOW_THRESHOLD', message: 'Asset quality dưới ngưỡng công bố' });
    }
    if (onProgress) onProgress(assets.length ? (index + 1) / assets.length : 1);
  }
  if (assets.length === 0 && onProgress) onProgress(1);
  assets.sort((left, right) => right.quality - left.quality || left.assetId.localeCompare(right.assetId));
  return { assets, failures };
}

module.exports = {
  clamp01,
  sourceContext,
  scoreAsset,
  validateAssetFile,
  scoreAndValidateAssets,
};
