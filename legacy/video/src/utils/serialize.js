const path = require('path');
const { sanitizePublicMessage, sanitizePublicFailure } = require('./sanitize');

function toAssetUrl(jobId, filePath) {
  if (!filePath) return null;
  return `/assets/${encodeURIComponent(jobId)}/${encodeURIComponent(path.basename(filePath))}`;
}

function serializeAsset(jobId, asset) {
  return {
    index: asset.index,
    label: asset.label,
    description: asset.description,
    confidence: asset.confidence,
    timestamp: asset.timestamp,
    timecode: asset.timecode,
    url: toAssetUrl(jobId, asset.framePath),
    thumbUrl: toAssetUrl(jobId, asset.thumbPath),
    clipUrl: toAssetUrl(jobId, asset.clipPath),
    clipThumbUrl: toAssetUrl(jobId, asset.clipPosterPath),
    clipDuration: Number(asset.clipDuration || 0),
  };
}

function serializeSceneClip(jobId, clip) {
  return {
    index: clip.index,
    start: clip.start,
    end: clip.end,
    duration: clip.duration,
    timecode: clip.timecode,
    url: toAssetUrl(jobId, clip.clipPath),
    posterUrl: toAssetUrl(jobId, clip.posterPath),
  };
}

function v2MediaUrl(jobId, kind, entityId, variant) {
  return `/api/v2/jobs/${encodeURIComponent(jobId)}/media/${encodeURIComponent(kind)}/${encodeURIComponent(entityId)}/${encodeURIComponent(variant)}`;
}

function cleanProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return {
    name: String(provider.name || provider.provider || 'unknown'),
    version: String(provider.version || provider.model || 'unknown'),
  };
}

function serializeV2Asset(jobId, asset) {
  const available = asset.files || {};
  return {
    assetId: asset.assetId,
    type: asset.type,
    description: asset.description || '',
    extractionMode: asset.extractionMode,
    attemptedExtractionMode: asset.attemptedExtractionMode || null,
    quality: Number(asset.quality || 0),
    qualityState: asset.qualityState || 'failed',
    qualityComponents: asset.qualityComponents || {},
    sourcePixelsRatio: Number(asset.sourcePixelsRatio || 0),
    reconstructedAreaRatio: Number(asset.reconstructedAreaRatio || 0),
    recoveryAreaRatio: Number(asset.recoveryAreaRatio || 0),
    width: Number(asset.width || 0),
    height: Number(asset.height || 0),
    source: asset.source ? {
      sceneId: asset.source.sceneId,
      elementId: asset.source.elementId,
      keyframeId: asset.source.keyframeId,
      timestamp: asset.source.timestamp,
      bbox: asset.source.bbox,
      originalResolution: asset.source.originalResolution || null,
    } : null,
    text: asset.text ? {
      content: asset.text.content || '',
      confidence: asset.text.confidence || 0,
      style: asset.text.style || null,
      provider: cleanProvider(asset.text.provider),
      fallback: Boolean(asset.text.fallback),
      error: sanitizePublicMessage(asset.text.error),
    } : null,
    segmentation: asset.segmentation ? {
      confidence: asset.segmentation.confidence,
      foregroundRatio: asset.segmentation.foregroundRatio,
      softAlphaRatio: asset.segmentation.softAlphaRatio,
      clippedBoundaryRatio: asset.segmentation.clippedBoundaryRatio,
      provider: cleanProvider(asset.segmentation.provider),
      fallbackReason: sanitizePublicMessage(asset.segmentation.fallbackReason),
      cacheHit: Boolean(asset.segmentation.cacheHit),
    } : null,
    reconstruction: asset.reconstruction ? {
      generated: Boolean(asset.reconstruction.generated),
      provider: cleanProvider(asset.reconstruction.provider),
      temporalSourceKeyframeId: asset.reconstruction.temporalSourceKeyframeId || null,
      alignment: asset.reconstruction.alignment ? {
        method: String(asset.reconstruction.alignment.method || 'unknown'),
        meanAbsoluteDifference: Number(asset.reconstruction.alignment.meanAbsoluteDifference || 0),
        comparedPixels: Number(asset.reconstruction.alignment.comparedPixels || 0),
        sampleResolution: asset.reconstruction.alignment.sampleResolution || null,
      } : null,
      artifactScore: asset.reconstruction.artifactScore || 0,
      fallbackReason: sanitizePublicMessage(asset.reconstruction.fallbackReason),
      cacheHit: Boolean(asset.reconstruction.cacheHit),
    } : null,
    occurrences: asset.occurrences || [],
    failure: sanitizePublicFailure(asset.failure),
    files: {
      primaryUrl: available.primary ? v2MediaUrl(jobId, 'asset', asset.assetId, 'primary') : null,
      thumbnailUrl: available.thumbnail ? v2MediaUrl(jobId, 'asset', asset.assetId, 'thumbnail') : null,
      maskUrl: available.mask ? v2MediaUrl(jobId, 'asset', asset.assetId, 'mask') : null,
      rawMaskUrl: available.rawMask ? v2MediaUrl(jobId, 'asset', asset.assetId, 'rawMask') : null,
      reconstructedMaskUrl: available.reconstructedMask
        ? v2MediaUrl(jobId, 'asset', asset.assetId, 'reconstructedMask')
        : null,
    },
  };
}

function serializeV2SceneSummary(jobId, scene) {
  return {
    sceneId: scene.sceneId,
    start: scene.start,
    end: scene.end,
    duration: Number((scene.end - scene.start).toFixed(3)),
    boundaryIn: scene.boundaryIn,
    boundaryOut: scene.boundaryOut,
    previewKeyframeId: scene.previewKeyframeId,
    previewUrl: scene.previewPath ? v2MediaUrl(jobId, 'scene', scene.sceneId, 'preview') : null,
    keyframeCount: scene.keyframes?.length || 0,
    elementCount: scene.elements?.length || 0,
    analysisStatus: scene.analysis?.status || 'pending',
    metrics: scene.metrics || {},
  };
}

function serializeV2Scene(job, scene) {
  const assets = (job.assets || []).filter((asset) => (
    (asset.occurrences || []).some((occurrence) => occurrence.sceneId === scene.sceneId)
  ));
  return {
    ...serializeV2SceneSummary(job.id, scene),
    keyframes: (scene.keyframes || []).map((keyframe) => ({
      keyframeId: keyframe.keyframeId,
      timestamp: keyframe.timestamp,
      selectionReason: keyframe.selectionReason || keyframe.reason || [],
      sharpness: keyframe.sharpness,
      motion: keyframe.motion,
      url: keyframe.path ? v2MediaUrl(job.id, 'keyframe', keyframe.keyframeId, 'frame') : null,
    })),
    elements: (scene.elements || []).map((element) => ({
      elementId: element.elementId,
      trackId: element.trackId || null,
      type: element.type,
      description: element.description || '',
      extractability: element.extractability,
      semanticConfidence: element.semanticConfidence,
      localizationConfidence: element.localizationConfidence,
      text: element.text || '',
      textStyle: element.textStyle || null,
      observations: element.observations || [],
      assetIds: element.assetIds || [],
    })),
    assets: assets.map((asset) => serializeV2Asset(job.id, asset)),
    analysis: scene.analysis ? {
      status: scene.analysis.status,
      summary: scene.analysis.summary || '',
      error: sanitizePublicMessage(scene.analysis.error),
      provider: cleanProvider(scene.analysis.provider),
    } : null,
  };
}

function serializeV2Job(job, { includeAssets = true } = {}) {
  return {
    id: job.id,
    schemaVersion: 2,
    resultType: 'decomposer',
    legacyFrameResult: false,
    status: job.status,
    stage: job.stage || job.status,
    progress: Number(job.progress || 0),
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl,
    originalFilename: job.originalFilename,
    video: job.video || null,
    sceneCount: job.scenes?.length || 0,
    assetCount: job.assetCount ?? (job.assets || []).filter((asset) => asset.qualityState !== 'failed').length,
    failureCount: job.failures?.length || 0,
    failures: (job.failures || []).map(sanitizePublicFailure).filter(Boolean),
    metrics: job.metrics || {},
    scenes: (job.scenes || []).map((scene) => serializeV2SceneSummary(job.id, scene)),
    assets: includeAssets ? (job.assets || []).map((asset) => serializeV2Asset(job.id, asset)) : undefined,
    queuePosition: job.queuePosition ?? null,
    error: sanitizePublicMessage(job.error),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
  };
}

function serializeJob(job) {
  if (Number(job.schemaVersion) === 2) return serializeV2Job(job);
  return {
    id: job.id,
    schemaVersion: Number(job.schemaVersion || 1),
    resultType: 'legacy-frame',
    legacyFrameResult: true,
    status: job.status,
    progress: job.progress,
    sourceType: job.sourceType,
    sourceUrl: job.sourceUrl,
    originalFilename: job.originalFilename,
    duration: job.duration,
    detectionMode: job.detectionMode ?? null,
    candidateCount: job.candidateCount ?? job.candidates?.length ?? 0,
    assetCount: job.assetCount ?? job.assets?.length ?? 0,
    assets: (job.assets ?? []).map((asset) => serializeAsset(job.id, asset)),
    sceneClips: (job.sceneClips ?? []).map((clip) => serializeSceneClip(job.id, clip)),
    queuePosition: job.queuePosition ?? null,
    error: sanitizePublicMessage(job.error),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function serializeJobSummary(job) {
  if (Number(job.schemaVersion) === 2) {
    return {
      id: job.id,
      schemaVersion: 2,
      resultType: 'decomposer',
      legacyFrameResult: false,
      status: job.status,
      stage: job.stage || job.status,
      progress: job.progress,
      sourceType: job.sourceType,
      assetCount: job.assetCount ?? job.assets?.filter?.((asset) => asset.qualityState !== 'failed').length ?? 0,
      sceneCount: job.sceneCount ?? job.scenes?.length ?? 0,
      queuePosition: job.queuePosition ?? null,
      createdAt: job.createdAt,
    };
  }
  return {
    id: job.id,
    schemaVersion: Number(job.schemaVersion || 1),
    resultType: 'legacy-frame',
    legacyFrameResult: true,
    status: job.status,
    progress: job.progress,
    sourceType: job.sourceType,
    assetCount: job.assetCount ?? job.assets?.length ?? 0,
    queuePosition: job.queuePosition ?? null,
    createdAt: job.createdAt,
  };
}

module.exports = {
  toAssetUrl,
  v2MediaUrl,
  serializeJob,
  serializeJobSummary,
  serializeAsset,
  serializeSceneClip,
  serializeV2Job,
  serializeV2Scene,
  serializeV2SceneSummary,
  serializeV2Asset,
};
