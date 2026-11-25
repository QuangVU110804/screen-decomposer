'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('../config');
const artifactStore = require('./artifactStore');
const { validateManifest } = require('../domain/decomposerSchema');
const { sanitizePublicMessage, sanitizePublicFailure } = require('../utils/sanitize');

function cleanProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return {
    name: String(provider.name || provider.provider || 'unknown'),
    version: String(provider.version || provider.model || 'unknown'),
  };
}

function relativeFile(root, filePath) {
  if (!filePath) return null;
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function copyOptional(source, destination) {
  if (!source || !fs.existsSync(source)) return null;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
  return destination;
}

function assetBaseName(asset) {
  const number = String(asset.assetId).replace(/^asset_/, '');
  const safeType = String(asset.type || 'unknown').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return `${safeType}_${number}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function replaceDirectoryTransactionally(stagingDir, finalDir, onCommitted) {
  const backupDir = `${finalDir}.backup-${randomUUID()}`;
  let movedExisting = false;
  let installedStaging = false;
  let committed = false;

  try {
    if (fs.existsSync(finalDir)) {
      await fs.promises.rename(finalDir, backupDir);
      movedExisting = true;
    }
    await fs.promises.rename(stagingDir, finalDir);
    installedStaging = true;
    if (onCommitted) await onCommitted();
    committed = true;
  } catch (error) {
    if (installedStaging || fs.existsSync(finalDir)) {
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    }
    if (movedExisting && fs.existsSync(backupDir)) {
      try {
        await fs.promises.rename(backupDir, finalDir);
      } catch (rollbackError) {
        error.rollbackError = rollbackError.message;
      }
    }
    throw error;
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  if (committed && movedExisting) {
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch((error) => {
      console.warn(`[package] committed ${finalDir}, but could not remove backup ${backupDir}: ${error.message}`);
    });
  }
}

function publicElement(element) {
  return {
    elementId: element.elementId,
    trackId: element.trackId || null,
    type: element.type,
    description: element.description,
    extractability: element.extractability,
    semanticConfidence: element.semanticConfidence,
    localizationConfidence: element.localizationConfidence,
    text: element.text || '',
    textStyle: element.textStyle || null,
    observations: element.observations,
    assetIds: element.assetIds || [],
  };
}

function publicAsset(asset, root) {
  return {
    assetId: asset.assetId,
    type: asset.type,
    description: asset.description,
    extractionMode: asset.extractionMode,
    attemptedExtractionMode: asset.attemptedExtractionMode || null,
    quality: asset.quality,
    qualityState: asset.qualityState,
    qualityComponents: asset.qualityComponents || {},
    sourcePixelsRatio: asset.sourcePixelsRatio,
    reconstructedAreaRatio: asset.reconstructedAreaRatio,
    recoveryAreaRatio: asset.recoveryAreaRatio || 0,
    width: asset.width || 0,
    height: asset.height || 0,
    source: asset.source ? {
      sceneId: asset.source.sceneId,
      elementId: asset.source.elementId,
      keyframeId: asset.source.keyframeId,
      timestamp: asset.source.timestamp,
      bbox: asset.source.bbox,
      cropTransform: asset.source.cropTransform || null,
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
      edgeContamination: asset.segmentation.edgeContamination,
      provider: cleanProvider(asset.segmentation.provider),
      fallbackReason: sanitizePublicMessage(asset.segmentation.fallbackReason),
      cacheHit: Boolean(asset.segmentation.cacheHit),
    } : null,
    reconstruction: asset.reconstruction ? {
      provider: cleanProvider(asset.reconstruction.provider),
      generated: Boolean(asset.reconstruction.generated),
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
      primary: relativeFile(root, asset.files?.primary),
      thumbnail: relativeFile(root, asset.files?.thumbnail),
      mask: relativeFile(root, asset.files?.mask),
      rawMask: relativeFile(root, asset.files?.rawMask),
      reconstructedMask: relativeFile(root, asset.files?.reconstructedMask),
    },
    filesByScene: Object.fromEntries(
      Object.entries(asset.filesByScene || {}).map(([sceneId, files]) => [
        sceneId,
        Object.fromEntries(Object.entries(files).map(([variant, filePath]) => [variant, relativeFile(root, filePath)])),
      ])
    ),
  };
}

function publicSceneAsset(asset, sceneRoot, sceneId) {
  const result = publicAsset(asset, sceneRoot);
  const sceneFiles = asset.filesByScene?.[sceneId] || {};
  result.occurrences = (asset.occurrences || []).filter((occurrence) => occurrence.sceneId === sceneId);
  result.files = {
    primary: relativeFile(sceneRoot, sceneFiles.primary),
    thumbnail: relativeFile(sceneRoot, sceneFiles.thumbnail),
    mask: relativeFile(sceneRoot, sceneFiles.mask),
    rawMask: relativeFile(sceneRoot, sceneFiles.rawMask),
    reconstructedMask: relativeFile(sceneRoot, sceneFiles.reconstructedMask),
  };
  delete result.filesByScene;
  return result;
}

function buildPublicManifest(job, root) {
  return {
    schemaVersion: 2,
    videoId: job.id,
    generatedAt: new Date().toISOString(),
    resultType: 'decomposer',
    video: job.video,
    scenes: (job.scenes || []).map((scene) => ({
      sceneId: scene.sceneId,
      start: scene.start,
      end: scene.end,
      boundaryIn: scene.boundaryIn,
      boundaryOut: scene.boundaryOut,
      previewKeyframeId: scene.previewKeyframeId,
      preview: relativeFile(root, scene.previewPath),
      keyframes: (scene.keyframes || []).map((keyframe) => ({
        keyframeId: keyframe.keyframeId,
        timestamp: keyframe.timestamp,
        selectionReason: keyframe.selectionReason || keyframe.reason,
        sharpness: keyframe.sharpness,
        motion: keyframe.motion,
        file: relativeFile(root, keyframe.path),
      })),
      elements: (scene.elements || []).map(publicElement),
      metrics: scene.metrics || {},
      analysis: scene.analysis ? {
        status: scene.analysis.status,
        summary: scene.analysis.summary || '',
        error: sanitizePublicMessage(scene.analysis.error),
        provider: cleanProvider(scene.analysis.provider),
      } : null,
    })),
    tracks: job.tracks || [],
    assets: (job.assets || []).map((asset) => publicAsset(asset, root)),
    failures: (job.failures || []).map(sanitizePublicFailure).filter(Boolean),
    metrics: job.metrics || {},
    notices: {
      provenance: 'DIRECT uses source pixels; SEGMENTED isolates source pixels; RECONSTRUCTED may contain inferred or generated pixels.',
      copyright: 'Technical extraction does not grant legal permission to reuse any asset.',
    },
  };
}

async function packageJob(job, options = {}) {
  validateManifest({
    schemaVersion: 2,
    videoId: job.id,
    video: job.video,
    scenes: job.scenes,
    tracks: job.tracks,
    assets: job.assets,
  }, { requireKeyframes: true });

  const finalDir = path.join(config.ASSET_DIR, String(job.id));
  const stagingDir = path.join(config.ASSET_DIR, `.staging-v2-${job.id}-${randomUUID()}`);
  await fs.promises.rm(stagingDir, { recursive: true, force: true });
  await fs.promises.mkdir(stagingDir, { recursive: true });
  // Build the staged pack from a detached copy. A failed build must not leave
  // the persisted job pointing at files inside a staging directory.
  const packagedJob = cloneJson(job);

  try {
    for (const scene of packagedJob.scenes || []) {
      const sceneRoot = path.join(stagingDir, scene.sceneId);
      const keyframeRoot = path.join(sceneRoot, 'keyframes');
      const sceneAssetRoot = path.join(sceneRoot, 'assets');
      await fs.promises.mkdir(keyframeRoot, { recursive: true });
      await fs.promises.mkdir(sceneAssetRoot, { recursive: true });
      const previewPath = path.join(sceneRoot, 'scene_preview.jpg');
      const copiedPreview = await copyOptional(scene.previewPath, previewPath);
      if (copiedPreview) scene.previewPath = copiedPreview;
      for (const keyframe of scene.keyframes || []) {
        const destination = path.join(keyframeRoot, `${keyframe.keyframeId}.png`);
        const copied = await copyOptional(keyframe.path, destination);
        if (copied) keyframe.path = copied;
      }
    }

    for (const asset of packagedJob.assets || []) {
      asset.filesByScene = {};
      if (asset.extractionMode === 'FAILED') continue;
      const base = assetBaseName(asset);
      for (const occurrence of asset.occurrences || []) {
        const outputDir = path.join(stagingDir, occurrence.sceneId, 'assets');
        const files = {
          primary: await copyOptional(asset.files?.primary, path.join(outputDir, `${base}.png`)),
          thumbnail: await copyOptional(asset.files?.thumbnail, path.join(outputDir, `${base}_thumb.jpg`)),
          mask: await copyOptional(asset.files?.mask, path.join(outputDir, `${base}_mask.png`)),
          rawMask: await copyOptional(asset.files?.rawMask, path.join(outputDir, `${base}_mask_raw.png`)),
          reconstructedMask: await copyOptional(
            asset.files?.reconstructedMask,
            path.join(outputDir, `${base}_reconstructed_mask.png`)
          ),
        };
        asset.filesByScene[occurrence.sceneId] = files;
      }
      const firstScene = asset.occurrences?.[0]?.sceneId;
      if (firstScene && asset.filesByScene[firstScene]) asset.files = asset.filesByScene[firstScene];
    }

    for (const scene of packagedJob.scenes || []) {
      const sceneAssets = (packagedJob.assets || []).filter((asset) => (
        (asset.occurrences || []).some((occurrence) => occurrence.sceneId === scene.sceneId)
      ));
      const sceneRoot = path.join(stagingDir, scene.sceneId);
      const metadata = {
        schemaVersion: 2,
        sceneId: scene.sceneId,
        start: scene.start,
        end: scene.end,
        boundaryIn: scene.boundaryIn,
        boundaryOut: scene.boundaryOut,
        previewKeyframeId: scene.previewKeyframeId,
        preview: relativeFile(sceneRoot, scene.previewPath),
        keyframes: (scene.keyframes || []).map((keyframe) => ({
          keyframeId: keyframe.keyframeId,
          timestamp: keyframe.timestamp,
          selectionReason: keyframe.selectionReason || keyframe.reason,
          file: relativeFile(sceneRoot, keyframe.path),
        })),
        elements: (scene.elements || []).map(publicElement),
        assetIds: sceneAssets.map((asset) => asset.assetId),
        assets: sceneAssets.map((asset) => publicSceneAsset(asset, sceneRoot, scene.sceneId)),
        notices: {
          provenance: 'DIRECT uses source pixels; SEGMENTED isolates source pixels; RECONSTRUCTED may contain inferred or generated pixels.',
          copyright: 'Technical extraction does not grant legal permission to reuse any asset.',
        },
      };
      await fs.promises.writeFile(
        path.join(stagingDir, scene.sceneId, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );
    }

    const manifest = buildPublicManifest(packagedJob, stagingDir);
    await fs.promises.writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    let finalManifest;
    await replaceDirectoryTransactionally(stagingDir, finalDir, async () => {
      const relocate = (filePath) => filePath
        ? path.join(finalDir, path.relative(stagingDir, filePath))
        : null;
      for (const scene of packagedJob.scenes || []) {
        scene.previewPath = relocate(scene.previewPath);
        for (const keyframe of scene.keyframes || []) keyframe.path = relocate(keyframe.path);
      }
      for (const asset of packagedJob.assets || []) {
        asset.files = Object.fromEntries(
          Object.entries(asset.files || {}).map(([variant, filePath]) => [variant, relocate(filePath)])
        );
        asset.filesByScene = Object.fromEntries(
          Object.entries(asset.filesByScene || {}).map(([sceneId, files]) => [
            sceneId,
            Object.fromEntries(Object.entries(files).map(([variant, filePath]) => [variant, relocate(filePath)])),
          ])
        );
      }
      finalManifest = buildPublicManifest(packagedJob, finalDir);
      await fs.promises.writeFile(
        path.join(finalDir, 'manifest.json'),
        JSON.stringify(finalManifest, null, 2),
        'utf8'
      );
      if (options.afterDirectoryCommit) await options.afterDirectoryCommit({ finalDir, finalManifest });
      await artifactStore.writeJsonAtomic(artifactStore.manifestPath(job.id), finalManifest);
    });
    job.scenes = packagedJob.scenes;
    job.tracks = packagedJob.tracks;
    job.assets = packagedJob.assets;
    return { job, manifest: finalManifest, outputDir: finalDir };
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  assetBaseName,
  buildPublicManifest,
  replaceDirectoryTransactionally,
  packageJob,
};
