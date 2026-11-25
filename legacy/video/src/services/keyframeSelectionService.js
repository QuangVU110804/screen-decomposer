'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const artifactStore = require('./artifactStore');
const { extractFrame } = require('../utils/ffmpeg');
const { sharpnessFromFile } = require('../utils/sharpness');
const { dhashFromFile, hamming } = require('../utils/hash');
const { validateKeyframes } = require('../domain/decomposerSchema');

function sampleTimestamps(scene, count) {
  const duration = scene.end - scene.start;
  const inset = Math.min(0.12, Math.max(0.001, duration * 0.02));
  if (count <= 1 || duration <= inset * 2) return [scene.start + duration / 2];
  return Array.from({ length: count }, (_unused, index) => (
    scene.start + inset + ((duration - inset * 2) * index) / (count - 1)
  ));
}

function reasonFor(index, length) {
  if (index === 0) return ['scene_start'];
  if (index === length - 1) return ['scene_end'];
  if (index === Math.floor((length - 1) / 2)) return ['scene_midpoint'];
  return ['composition_change'];
}

function selectDiverse(candidates, target) {
  if (candidates.length <= target) return [...candidates].sort((a, b) => a.timestamp - b.timestamp);
  const quality = (candidate) => Number(candidate.qualityScore ?? (
    candidate.sharpness / Math.max(1, candidate.sharpness + 150)
  ));
  const ranked = [...candidates].sort((a, b) => quality(b) - quality(a));
  const selected = [ranked.shift()];
  while (selected.length < target && ranked.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < ranked.length; index++) {
      const candidate = ranked[index];
      const diversity = Math.min(...selected.map((item) => hamming(item.hash, candidate.hash))) / 64;
      const score = diversity * 0.68 + quality(candidate) * 0.32;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    selected.push(ranked.splice(bestIndex, 1)[0]);
  }
  return selected.sort((a, b) => a.timestamp - b.timestamp);
}

function selectAnalysisCandidates(candidates, target) {
  const safe = candidates.filter((candidate) => (
    !candidate.blackFrame && Number(candidate.transitionPenalty || 0) < 0.8
  ));
  if (safe.length >= target) return selectDiverse(safe, target);
  const nonBlack = candidates.filter((candidate) => !candidate.blackFrame);
  if (nonBlack.length >= target) return selectDiverse(nonBlack, target);
  return selectDiverse(candidates, target);
}

function summarizeKeyframeMetrics(scenes, configuredBudget, effectiveBudget) {
  return {
    totalKeyframes: scenes.reduce((sum, scene) => sum + (scene.keyframes?.length || 0), 0),
    totalVisionPixelsEstimate: scenes.reduce(
      (sum, scene) => sum + Number(scene.metrics?.visionPixelsEstimate || 0),
      0
    ),
    totalSelectionElapsedMs: scenes.reduce(
      (sum, scene) => sum + Number(scene.metrics?.selectionElapsedMs || 0),
      0
    ),
    selectedTransitionFrames: scenes.reduce(
      (sum, scene) => sum + Number(scene.metrics?.selectedTransitionFrames || 0),
      0
    ),
    selectedBlackFrames: scenes.reduce(
      (sum, scene) => sum + (scene.keyframes || []).filter(
        (keyframe) => Boolean(keyframe.features?.blackFrame)
      ).length,
      0
    ),
    keyframeBudget: configuredBudget,
    effectiveKeyframeBudget: effectiveBudget,
    budgetExpandedForCoverage: effectiveBudget > configuredBudget,
  };
}

async function textStructureHash(filePath) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .grayscale()
    .resize(64, 36, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gradients = new Float64Array(info.width * info.height);
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const index = y * info.width + x;
      gradients[index] = (
        Math.abs(data[index + 1] - data[index - 1]) +
        Math.abs(data[index + info.width] - data[index - info.width])
      ) / 2;
    }
  }
  const blocks = [];
  for (let blockY = 0; blockY < 16; blockY++) {
    const startY = Math.floor(blockY * info.height / 16);
    const endY = Math.max(startY + 1, Math.floor((blockY + 1) * info.height / 16));
    for (let blockX = 0; blockX < 16; blockX++) {
      const startX = Math.floor(blockX * info.width / 16);
      const endX = Math.max(startX + 1, Math.floor((blockX + 1) * info.width / 16));
      let sum = 0;
      let count = 0;
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          sum += gradients[y * info.width + x];
          count++;
        }
      }
      blocks.push(sum / Math.max(1, count));
    }
  }
  const positive = blocks.filter((value) => value >= 1).sort((left, right) => left - right);
  const threshold = positive.length
    ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.6))]
    : Infinity;
  let bits = '';
  for (const value of blocks) bits += value >= threshold && value >= 1 ? '1' : '0';
  let hash = '';
  for (let index = 0; index < bits.length; index += 4) {
    hash += parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hash;
}

async function frameStats(filePath) {
  const stats = await sharp(filePath, { failOn: 'none' })
    .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .stats();
  const channels = stats.channels.slice(0, 3);
  const brightness = channels.reduce((sum, channel) => sum + channel.mean, 0) / Math.max(1, channels.length);
  const contrast = channels.reduce((sum, channel) => sum + channel.stdev, 0) / Math.max(1, channels.length);
  return { brightness, contrast };
}

async function selectForScene(jobId, videoPath, scene, options = {}) {
  const started = Date.now();
  await artifactStore.initializeScene(jobId, scene.sceneId);
  const duration = scene.end - scene.start;
  const normalCount = options.keyframesPerScene ?? config.KEYFRAMES_PER_SCENE;
  const maxCount = options.maxKeyframesPerScene ?? config.MAX_KEYFRAMES_PER_SCENE;
  const target = Math.min(maxCount, duration > 12 ? Math.max(normalCount, 6) : normalCount);
  const sampleCount = Math.min(maxCount * 2, Math.max(target, Math.ceil(duration * 1.5)));
  const timestamps = sampleTimestamps(scene, sampleCount);
  const candidates = [];
  let previousHash = null;
  let previousTextHash = null;
  for (let index = 0; index < timestamps.length; index++) {
    const candidatePath = path.join(
      artifactStore.keyframeDir(jobId, scene.sceneId),
      `.candidate_${String(index + 1).padStart(2, '0')}.png`
    );
    await extractFrame(videoPath, timestamps[index], candidatePath, { maxEdgePx: options.proxyMaxEdgePx || 1280 });
    try {
      const [sharpness, hash, textHash, visual] = await Promise.all([
        sharpnessFromFile(candidatePath),
        dhashFromFile(candidatePath),
        textStructureHash(candidatePath),
        frameStats(candidatePath),
      ]);
      const motion = previousHash ? hamming(previousHash, hash) / 64 : 0;
      const textChange = previousTextHash ? hamming(previousTextHash, textHash) / 256 : 0;
      const blackFrame = visual.brightness < 12 && visual.contrast < 10;
      const blurScore = 1 - (sharpness / Math.max(1, sharpness + 150));
      const transitionPenalty = Math.max(
        blackFrame ? 1 : 0,
        blurScore > 0.92 && motion > 0.35 ? 0.8 : 0
      );
      const qualityScore =
        (sharpness / Math.max(1, sharpness + 150)) * 0.52 +
        Math.min(1, visual.contrast / 64) * 0.16 +
        (1 - transitionPenalty) * 0.24 +
        Math.min(1, textChange * 2) * 0.08;
      const reason = reasonFor(index, timestamps.length);
      if (
        textChange >= Number(options.textChangeThreshold ?? 0.03) &&
        !reason.includes('text_change')
      ) {
        reason.push('text_change');
      }
      candidates.push({
        timestamp: Number(timestamps[index].toFixed(3)),
        path: candidatePath,
        sharpness,
        hash,
        motion,
        brightness: visual.brightness,
        contrast: visual.contrast,
        textHash,
        textChange,
        blackFrame,
        transitionPenalty,
        qualityScore,
        reason,
      });
      previousHash = hash;
      previousTextHash = textHash;
    } catch (error) {
      await fs.promises.rm(candidatePath, { force: true }).catch(() => {});
    }
  }
  if (candidates.length === 0) throw new Error(`${scene.sceneId} không trích được keyframe hợp lệ`);

  const chosen = selectAnalysisCandidates(candidates, Math.min(target, candidates.length));
  const keep = new Set(chosen.map((candidate) => candidate.path));
  const keyframes = [];
  for (let index = 0; index < chosen.length; index++) {
    const candidate = chosen[index];
    const keyframeId = `kf_${scene.sceneId.slice(6)}_${String(index + 1).padStart(2, '0')}`;
    const finalPath = path.join(artifactStore.keyframeDir(jobId, scene.sceneId), `${keyframeId}.png`);
    // Selection is performed on cheap proxies; the canonical keyframe is then
    // sought again at source resolution so downstream crops do not inherit the
    // analysis proxy's resolution loss.
    await extractFrame(videoPath, candidate.timestamp, finalPath);
    await fs.promises.rm(candidate.path, { force: true }).catch(() => {});
    keyframes.push({
      keyframeId,
      timestamp: candidate.timestamp,
      selectionReason: candidate.reason,
      sharpness: Number(candidate.sharpness.toFixed(3)),
      motion: Number(candidate.motion.toFixed(4)),
      features: {
        brightness: Number(candidate.brightness.toFixed(3)),
        contrast: Number(candidate.contrast.toFixed(3)),
        blackFrame: candidate.blackFrame,
        transitionPenalty: Number(candidate.transitionPenalty.toFixed(4)),
        compositionDifference: Number(candidate.motion.toFixed(4)),
        textChange: Number(candidate.textChange.toFixed(4)),
      },
      path: finalPath,
    });
  }
  for (const candidate of candidates) {
    if (!keep.has(candidate.path)) await fs.promises.rm(candidate.path, { force: true }).catch(() => {});
  }
  scene.keyframes = keyframes;
  const chosenById = new Map(chosen.map((candidate, index) => [`kf_${scene.sceneId.slice(6)}_${String(index + 1).padStart(2, '0')}`, candidate]));
  scene.previewKeyframeId = [...keyframes].sort((left, right) => (
    Number(chosenById.get(right.keyframeId)?.qualityScore || 0) -
    Number(chosenById.get(left.keyframeId)?.qualityScore || 0)
  ))[0].keyframeId;
  scene.metrics = {
    ...(scene.metrics || {}),
    sampledKeyframes: timestamps.length,
    selectedKeyframes: keyframes.length,
    rejectedBlackFrames: candidates.filter((candidate) => candidate.blackFrame && !keep.has(candidate.path)).length,
    selectedTransitionFrames: chosen.filter((candidate) => candidate.transitionPenalty >= 0.8).length,
    meanTextChange: Number((
      candidates.reduce((sum, candidate) => sum + candidate.textChange, 0) /
      Math.max(1, candidates.length)
    ).toFixed(4)),
    visionPixelsEstimate: keyframes.length * 1280 * 720,
    selectionElapsedMs: Date.now() - started,
  };
  validateKeyframes(scene);
  return scene;
}

async function selectKeyframes(jobId, videoPath, scenes, onProgress, options = {}) {
  const configuredBudget = options.maxTotalKeyframes ?? config.MAX_TOTAL_KEYFRAMES;
  // Canonical scene coverage wins over an analysis budget: never leave a
  // valid scene without a keyframe merely because a long video has many cuts.
  const totalBudget = Math.max(configuredBudget, scenes.length);
  let used = 0;
  for (let index = 0; index < scenes.length; index++) {
    const remainingScenes = scenes.length - index;
    const remainingBudget = Math.max(1, totalBudget - used);
    const perSceneBudget = Math.max(1, Math.min(
      options.maxKeyframesPerScene ?? config.MAX_KEYFRAMES_PER_SCENE,
      Math.floor(remainingBudget / remainingScenes)
    ));
    await selectForScene(jobId, videoPath, scenes[index], { ...options, maxKeyframesPerScene: perSceneBudget });
    used += scenes[index].keyframes.length;
    if (onProgress) onProgress((index + 1) / scenes.length, scenes[index]);
  }
  return {
    scenes,
    metrics: summarizeKeyframeMetrics(scenes, configuredBudget, totalBudget),
  };
}

module.exports = {
  sampleTimestamps,
  selectDiverse,
  selectAnalysisCandidates,
  summarizeKeyframeMetrics,
  textStructureHash,
  selectForScene,
  selectKeyframes,
};
