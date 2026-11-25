'use strict';

const fs = require('fs');
const config = require('../config');
const {
  dhashFromFile,
  hamming,
  chromaFromFile,
  chromaDistance,
} = require('../utils/hash');
const { tokens, jaccard } = require('./elementAssociationService');
const embeddingService = require('./embeddingService');

function dimensionsSimilarity(left, right) {
  const leftRatio = Number(left.width || 0) / Math.max(1, Number(left.height || 0));
  const rightRatio = Number(right.width || 0) / Math.max(1, Number(right.height || 0));
  if (!leftRatio || !rightRatio) return 0;
  return Math.min(leftRatio, rightRatio) / Math.max(leftRatio, rightRatio);
}

function uniqueOccurrences(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${value.sceneId}:${value.elementId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fingerprint(asset) {
  if (asset.extractionMode === 'FAILED' || !asset.files?.primary || !fs.existsSync(asset.files.primary)) return null;
  const semanticText = `${asset.type} ${asset.description || ''} ${asset.text?.content || ''}`;
  const embedding = await embeddingService.embed(semanticText);
  return {
    hash: await dhashFromFile(asset.files.primary),
    chroma: await chromaFromFile(asset.files.primary).catch(() => null),
    maskHash: asset.files?.mask && fs.existsSync(asset.files.mask)
      ? await dhashFromFile(asset.files.mask).catch(() => null)
      : null,
    descriptionTokens: tokens(`${asset.type} ${asset.description || ''} ${asset.text?.content || ''}`),
    embedding: embedding.vector,
    embeddingProvider: embedding.provider,
  };
}

function matchScore(left, right, leftFingerprint, rightFingerprint, options = {}) {
  if (!leftFingerprint || !rightFingerprint || left.type !== right.type) return null;
  const hashDistance = hamming(leftFingerprint.hash, rightFingerprint.hash);
  const maxHamming = options.maxHamming ?? config.ASSET_DEDUPE_HAMMING;
  const dimensions = dimensionsSimilarity(left, right);
  const description = jaccard(leftFingerprint.descriptionTokens, rightFingerprint.descriptionTokens);
  const embedding = embeddingService.cosineSimilarity(leftFingerprint.embedding, rightFingerprint.embedding);
  const chroma = leftFingerprint.chroma && rightFingerprint.chroma
    ? chromaDistance(leftFingerprint.chroma, rightFingerprint.chroma)
    : 0;
  const maskDistance = leftFingerprint.maskHash && rightFingerprint.maskHash
    ? hamming(leftFingerprint.maskHash, rightFingerprint.maskHash)
    : null;
  const sameTrack = Boolean(
    left.source?.trackId && right.source?.trackId && left.source.trackId === right.source.trackId
  );
  const safeMatch = hashDistance <= maxHamming &&
    chroma <= 0.12 &&
    (maskDistance === null || maskDistance <= Math.max(maxHamming, 8)) &&
    dimensions >= 0.85 &&
    (sameTrack || description >= 0.5 || embedding >= 0.82);
  return {
    matched: safeMatch,
    hashDistance,
    dimensions: Number(dimensions.toFixed(4)),
    description: Number(description.toFixed(4)),
    embeddingSimilarity: Number(embedding.toFixed(4)),
    chromaDistance: Number(chroma.toFixed(4)),
    maskDistance,
    sameTrack,
    score: Number((
      (1 - hashDistance / 64) * 0.55 +
      dimensions * 0.2 +
      Math.max(description, embedding) * 0.15 +
      (sameTrack ? 0.1 : 0)
    ).toFixed(4)),
  };
}

async function deduplicateAssets(assets, scenes, options = {}) {
  const kept = [];
  const duplicates = [];
  const fingerprints = new Map();
  for (const asset of assets) fingerprints.set(asset.assetId, await fingerprint(asset));

  for (const asset of assets) {
    if (asset.extractionMode === 'FAILED') {
      kept.push(asset);
      continue;
    }
    let match = null;
    let reason = null;
    for (const candidate of kept) {
      if (candidate.extractionMode === 'FAILED') continue;
      const comparison = matchScore(
        asset,
        candidate,
        fingerprints.get(asset.assetId),
        fingerprints.get(candidate.assetId),
        options
      );
      if (comparison?.matched && (!reason || comparison.score > reason.score)) {
        match = candidate;
        reason = comparison;
      }
    }
    if (!match) {
      kept.push(asset);
      continue;
    }
    match.occurrences = uniqueOccurrences([...(match.occurrences || []), ...(asset.occurrences || [])]);
    match.dedupe = {
      ...(match.dedupe || {}),
      mergedAssetIds: [...(match.dedupe?.mergedAssetIds || []), asset.assetId],
      decisions: [...(match.dedupe?.decisions || []), { mergedAssetId: asset.assetId, ...reason }],
    };
    duplicates.push({ duplicateAssetId: asset.assetId, canonicalAssetId: match.assetId, ...reason });
    for (const scene of scenes) {
      for (const element of scene.elements || []) {
        if (!Array.isArray(element.assetIds) || !element.assetIds.includes(asset.assetId)) continue;
        element.assetIds = [...new Set(element.assetIds.map((id) => id === asset.assetId ? match.assetId : id))];
      }
    }
  }

  kept.sort((left, right) => right.quality - left.quality || left.assetId.localeCompare(right.assetId));
  return {
    assets: kept,
    duplicates,
    metrics: {
      inputAssets: assets.length,
      outputAssets: kept.length,
      duplicateCount: duplicates.length,
    },
  };
}

module.exports = {
  dimensionsSimilarity,
  fingerprint,
  matchScore,
  deduplicateAssets,
};
