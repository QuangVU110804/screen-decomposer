'use strict';

const SCHEMA_VERSION = 2;
const ELEMENT_TYPES = new Set([
  'person', 'character', 'background', 'image', 'screenshot', 'text', 'graphic',
  'logo', 'object', 'overlay', 'unknown',
]);
const EXTRACTABILITY = new Set(['direct', 'segmentable', 'requires_inpainting', 'not_extractable']);
const EXTRACTION_MODES = new Set(['DIRECT', 'SEGMENTED', 'RECONSTRUCTED', 'FAILED']);
const QUALITY_STATES = new Set(['usable', 'review', 'failed']);

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function validateBbox(value, label = 'bbox') {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} must contain [x,y,width,height]`);
  const bbox = value.map((part, index) => finite(part, `${label}[${index}]`));
  const [x, y, width, height] = bbox;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new Error(`${label} must be normalized and stay inside the frame`);
  }
  return bbox.map((part) => Number(part.toFixed(6)));
}

function validateCorners(value, label = 'corners') {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} must contain four [x,y] points`);
  }
  return value.map((point, pointIndex) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new Error(`${label}[${pointIndex}] must contain [x,y]`);
    }
    const x = finite(point[0], `${label}[${pointIndex}][0]`);
    const y = finite(point[1], `${label}[${pointIndex}][1]`);
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error(`${label}[${pointIndex}] must stay inside the normalized frame`);
    }
    return [Number(x.toFixed(6)), Number(y.toFixed(6))];
  });
}

function validateScenes(scenes, duration) {
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('scenes must be a non-empty array');
  const ids = new Set();
  const total = finite(duration, 'video.duration');
  let cursor = 0;
  for (const [index, scene] of scenes.entries()) {
    if (!scene || typeof scene.sceneId !== 'string' || !/^scene_\d{3,}$/.test(scene.sceneId)) {
      throw new Error(`scenes[${index}].sceneId is invalid`);
    }
    if (ids.has(scene.sceneId)) throw new Error(`duplicate sceneId: ${scene.sceneId}`);
    ids.add(scene.sceneId);
    const start = finite(scene.start, `${scene.sceneId}.start`);
    const end = finite(scene.end, `${scene.sceneId}.end`);
    if (Math.abs(start - cursor) > 0.002) throw new Error(`${scene.sceneId} creates a gap or overlap at ${cursor}`);
    if (end <= start) throw new Error(`${scene.sceneId} must have a positive duration`);
    cursor = end;
  }
  if (Math.abs(cursor - total) > 0.002) throw new Error(`scene partition ends at ${cursor}, expected ${total}`);
  return scenes;
}

function validateKeyframes(scene) {
  if (!Array.isArray(scene.keyframes) || scene.keyframes.length === 0) {
    throw new Error(`${scene.sceneId} must have at least one keyframe`);
  }
  const ids = new Set();
  for (const keyframe of scene.keyframes) {
    if (!keyframe || typeof keyframe.keyframeId !== 'string' || ids.has(keyframe.keyframeId)) {
      throw new Error(`${scene.sceneId} has an invalid or duplicate keyframeId`);
    }
    ids.add(keyframe.keyframeId);
    const timestamp = finite(keyframe.timestamp, `${keyframe.keyframeId}.timestamp`);
    if (timestamp < scene.start - 0.001 || timestamp >= scene.end + 0.001) {
      throw new Error(`${keyframe.keyframeId} is outside ${scene.sceneId}`);
    }
    const reasons = keyframe.selectionReason || keyframe.reason;
    if (!Array.isArray(reasons) || reasons.length === 0 || reasons.some((reason) => typeof reason !== 'string')) {
      throw new Error(`${keyframe.keyframeId} must record selectionReason`);
    }
  }
  if (scene.previewKeyframeId && !ids.has(scene.previewKeyframeId)) {
    throw new Error(`${scene.sceneId}.previewKeyframeId references an unknown keyframe`);
  }
  return ids;
}

function validateElements(scene) {
  const keyframeIds = new Set((scene.keyframes || []).map((item) => item.keyframeId));
  const elementIds = new Set();
  for (const element of scene.elements || []) {
    if (!element || typeof element.elementId !== 'string' || elementIds.has(element.elementId)) {
      throw new Error(`${scene.sceneId} has an invalid or duplicate elementId`);
    }
    elementIds.add(element.elementId);
    if (!ELEMENT_TYPES.has(element.type)) throw new Error(`${element.elementId}.type is invalid`);
    if (!EXTRACTABILITY.has(element.extractability)) throw new Error(`${element.elementId}.extractability is invalid`);
    if (!Array.isArray(element.observations) || element.observations.length === 0) {
      throw new Error(`${element.elementId} needs at least one observation`);
    }
    for (const observation of element.observations) {
      if (!keyframeIds.has(observation.keyframeId)) throw new Error(`${element.elementId} references an unknown keyframe`);
      observation.bbox = validateBbox(observation.bbox, `${element.elementId}.bbox`);
      if (observation.corners !== undefined && observation.corners !== null) {
        observation.corners = validateCorners(observation.corners, `${element.elementId}.corners`);
      }
      observation.visibility = clamp01(observation.visibility);
      observation.occlusion = clamp01(observation.occlusion);
      observation.motion = clamp01(observation.motion);
    }
  }
  return elementIds;
}

function validateTracks(tracks, scenes) {
  if (!Array.isArray(tracks)) throw new Error('tracks must be an array');
  const elementsByKey = new Map();
  for (const scene of scenes) {
    for (const element of scene.elements || []) {
      elementsByKey.set(`${scene.sceneId}:${element.elementId}`, element);
    }
  }
  const ids = new Set();
  const trackedElements = new Map();
  for (const track of tracks) {
    if (!track || typeof track.trackId !== 'string' || ids.has(track.trackId)) {
      throw new Error('trackId is invalid or duplicated');
    }
    ids.add(track.trackId);
    if (!ELEMENT_TYPES.has(track.type)) throw new Error(`${track.trackId}.type is invalid`);
    const occurrenceKeys = new Set();
    for (const occurrence of track.occurrences || []) {
      const key = `${occurrence.sceneId}:${occurrence.elementId}`;
      const element = elementsByKey.get(key);
      if (!element) {
        throw new Error(`${track.trackId} references an unknown element`);
      }
      if (occurrenceKeys.has(key)) throw new Error(`${track.trackId} duplicates an element occurrence`);
      if (trackedElements.has(key)) {
        throw new Error(`${key} belongs to multiple tracks`);
      }
      if (element.type !== track.type) throw new Error(`${track.trackId} type does not match ${key}`);
      if (element.trackId !== track.trackId) {
        throw new Error(`${key}.trackId does not match ${track.trackId}`);
      }
      occurrenceKeys.add(key);
      trackedElements.set(key, track.trackId);
    }
  }
  for (const [key, element] of elementsByKey) {
    if (!element.trackId || !ids.has(element.trackId)) {
      throw new Error(`${key} references an unknown track`);
    }
    if (trackedElements.get(key) !== element.trackId) {
      throw new Error(`${key} is missing from ${element.trackId}.occurrences`);
    }
  }
  return tracks;
}

function validateAssets(assets, scenes) {
  if (!Array.isArray(assets)) throw new Error('assets must be an array');
  const sceneIds = new Set(scenes.map((scene) => scene.sceneId));
  const elementsByKey = new Map();
  for (const scene of scenes) {
    for (const element of scene.elements || []) {
      elementsByKey.set(`${scene.sceneId}:${element.elementId}`, element);
    }
  }
  const ids = new Set();
  const occurrencesByAsset = new Map();
  for (const asset of assets) {
    if (!asset || typeof asset.assetId !== 'string' || !/^asset_\d{3,}$/.test(asset.assetId) || ids.has(asset.assetId)) {
      throw new Error('assetId is invalid or duplicated');
    }
    ids.add(asset.assetId);
    if (!ELEMENT_TYPES.has(asset.type)) throw new Error(`${asset.assetId}.type is invalid`);
    if (!EXTRACTION_MODES.has(asset.extractionMode)) throw new Error(`${asset.assetId}.extractionMode is invalid`);
    if (asset.extractionMode !== 'RECONSTRUCTED' && Number(asset.reconstructedAreaRatio || 0) > 0) {
      throw new Error(`${asset.assetId} contains reconstructed pixels but is not RECONSTRUCTED`);
    }
    if (asset.qualityState && !QUALITY_STATES.has(asset.qualityState)) throw new Error(`${asset.assetId}.qualityState is invalid`);
    const sourceRatio = Number(asset.sourcePixelsRatio ?? 0);
    const reconstructedRatio = Number(asset.reconstructedAreaRatio ?? 0);
    if (!Number.isFinite(sourceRatio) || sourceRatio < 0 || sourceRatio > 1) {
      throw new Error(`${asset.assetId}.sourcePixelsRatio is invalid`);
    }
    if (!Number.isFinite(reconstructedRatio) || reconstructedRatio < 0 || reconstructedRatio > 1) {
      throw new Error(`${asset.assetId}.reconstructedAreaRatio is invalid`);
    }
    if (asset.extractionMode === 'DIRECT' && sourceRatio !== 1) {
      throw new Error(`${asset.assetId} DIRECT must contain source pixels only`);
    }
    if (
      asset.extractionMode === 'SEGMENTED' &&
      (sourceRatio !== 1 || reconstructedRatio !== 0)
    ) {
      throw new Error(`${asset.assetId} SEGMENTED must isolate source pixels without reconstruction`);
    }
    if (asset.extractionMode === 'RECONSTRUCTED') {
      if (!asset.reconstruction?.provider) {
        throw new Error(`${asset.assetId} RECONSTRUCTED must record provider metadata`);
      }
      const recoveryRatio = Number(asset.recoveryAreaRatio || 0);
      if (
        (reconstructedRatio > 0 || recoveryRatio > 0) &&
        !asset.files?.reconstructedMask
      ) {
        throw new Error(`${asset.assetId} RECONSTRUCTED must include a reconstruction mask`);
      }
      if (
        reconstructedRatio > 0 &&
        Math.abs(sourceRatio + reconstructedRatio - 1) > 0.02
      ) {
        throw new Error(`${asset.assetId} generated/source pixel ratios must sum to 1`);
      }
    }
    if (
      asset.extractionMode !== 'FAILED' &&
      (!Array.isArray(asset.occurrences) || asset.occurrences.length === 0)
    ) {
      throw new Error(`${asset.assetId} must record at least one occurrence`);
    }
    const occurrenceKeys = new Set();
    for (const occurrence of asset.occurrences || []) {
      if (!sceneIds.has(occurrence.sceneId)) throw new Error(`${asset.assetId} references an unknown scene`);
      const key = `${occurrence.sceneId}:${occurrence.elementId || ''}`;
      const element = elementsByKey.get(key);
      if (!element) {
        throw new Error(`${asset.assetId} references an unknown element`);
      }
      if (occurrenceKeys.has(key)) throw new Error(`${asset.assetId} duplicates an occurrence`);
      if (!Array.isArray(element.assetIds) || !element.assetIds.includes(asset.assetId)) {
        throw new Error(`${key}.assetIds is missing ${asset.assetId}`);
      }
      occurrenceKeys.add(key);
    }
    occurrencesByAsset.set(asset.assetId, occurrenceKeys);
  }
  for (const [key, element] of elementsByKey) {
    for (const assetId of element.assetIds || []) {
      if (!ids.has(assetId)) throw new Error(`${key}.assetIds references unknown asset ${assetId}`);
      if (!occurrencesByAsset.get(assetId)?.has(key)) {
        throw new Error(`${assetId}.occurrences is missing ${key}`);
      }
    }
  }
  return assets;
}

function validateManifest(manifest, { requireKeyframes = false } = {}) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!manifest.video || !Number.isFinite(Number(manifest.video.duration))) throw new Error('video metadata is missing');
  validateScenes(manifest.scenes, manifest.video.duration);
  for (const scene of manifest.scenes) {
    if (requireKeyframes) validateKeyframes(scene);
    if (scene.elements?.length) validateElements(scene);
  }
  validateTracks(manifest.tracks || [], manifest.scenes);
  validateAssets(manifest.assets || [], manifest.scenes);
  return manifest;
}

function makeManifest(jobId, video = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    videoId: String(jobId),
    video: {
      duration: Number(video.duration || 0),
      width: Number(video.width || 0),
      height: Number(video.height || 0),
      fps: Number(video.fps || 0),
    },
    scenes: [],
    tracks: [],
    assets: [],
    metrics: {},
  };
}

module.exports = {
  SCHEMA_VERSION,
  ELEMENT_TYPES,
  EXTRACTABILITY,
  EXTRACTION_MODES,
  QUALITY_STATES,
  clamp01,
  validateBbox,
  validateCorners,
  validateScenes,
  validateKeyframes,
  validateElements,
  validateTracks,
  validateAssets,
  validateManifest,
  makeManifest,
};
