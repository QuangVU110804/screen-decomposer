'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const artifactStore = require('./artifactStore');
const { runFfmpeg, parseSceneEvents, parseBlackIntervals, extractFrame } = require('../utils/ffmpeg');
const { validateScenes } = require('../domain/decomposerSchema');

function roundTime(value) { return Number(Number(value).toFixed(3)); }

function boundaryPriority(event) {
  switch (event?.type) {
    case 'hard_cut': return 4;
    case 'fade': return 3;
    case 'dissolve_or_composition_change': return 2;
    case 'motion_discontinuity': return 1;
    default: return 0;
  }
}

function publicBoundaryEvidence(event) {
  return {
    timestamp: roundTime(event.timestamp),
    type: String(event.type || 'unknown'),
    confidence: Number(Number(event.confidence || 0).toFixed(4)),
    score: Number.isFinite(Number(event.score))
      ? Number(Number(event.score).toFixed(4))
      : null,
    signal: String(event.signal || event.type || 'unknown'),
    reason: event.reason ? String(event.reason) : null,
    interval: event.interval ? {
      start: roundTime(event.interval.start),
      end: roundTime(event.interval.end),
      duration: roundTime(event.interval.duration),
    } : null,
  };
}

function dedupeBoundaries(events, tolerance = 0.12) {
  const sorted = [...events]
    .filter((event) => Number.isFinite(event.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp || Number(b.confidence || 0) - Number(a.confidence || 0));
  const result = [];
  for (const event of sorted) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.timestamp - event.timestamp) <= tolerance) {
      const priorityDifference = boundaryPriority(event) - boundaryPriority(previous);
      if (
        priorityDifference > 0 ||
        (
          priorityDifference === 0 &&
          Number(event.confidence || 0) > Number(previous.confidence || 0)
        )
      ) {
        result[result.length - 1] = event;
      }
    } else {
      result.push(event);
    }
  }
  return result;
}

function parseMotionSamples(stderr) {
  const samples = [];
  let timestamp = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const timeMatch = line.match(/\bpts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
    if (timeMatch) {
      timestamp = Number(timeMatch[1]);
      continue;
    }
    const differenceMatch = line.match(
      /lavfi\.signalstats\.YDIF=([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i
    );
    if (!differenceMatch || !Number.isFinite(timestamp)) continue;
    const difference = Number(differenceMatch[1]);
    if (Number.isFinite(difference)) samples.push({ timestamp, difference });
  }
  return samples;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function motionDiscontinuityEvents(samples, options = {}) {
  const absoluteThreshold = Number(options.motionYdifThreshold ?? 18);
  const spikeRatioThreshold = Number(options.motionSpikeRatio ?? 2.5);
  const radius = Math.max(1, Number(options.motionWindowRadius ?? 3));
  const events = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.difference)) continue;
    const neighbors = samples
      .slice(Math.max(0, index - radius), Math.min(samples.length, index + radius + 1))
      .filter((_value, neighborIndex) => Math.max(0, index - radius) + neighborIndex !== index)
      .map((value) => value.difference)
      .filter(Number.isFinite);
    const baseline = median(neighbors);
    const spikeRatio = sample.difference / Math.max(2, baseline);
    if (sample.difference < absoluteThreshold || spikeRatio < spikeRatioThreshold) continue;
    events.push({
      timestamp: sample.timestamp,
      type: 'motion_discontinuity',
      signal: 'signalstats_ydif_spike',
      confidence: Math.max(0.45, Math.min(0.9, sample.difference / 100)),
      score: Math.max(0, Math.min(1, sample.difference / 100)),
      motionDifference: sample.difference,
      localMotionBaseline: baseline,
      spikeRatio,
    });
  }
  return events;
}

function canonicalPartition(duration, rawEvents, options = {}) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) throw new Error('duration must be positive');
  const minDuration = options.minSceneDurationSec ?? config.MIN_SCENE_DURATION_SEC;
  const maxDuration = options.maxSceneDurationSec ?? config.MAX_SCENE_DURATION_SEC;
  const candidates = dedupeBoundaries(rawEvents)
    .filter((event) => event.timestamp > 0.001 && event.timestamp < total - 0.001);

  const accepted = [];
  const merged = [];
  let cursor = 0;
  for (const event of candidates) {
    if (event.timestamp - cursor < minDuration) {
      merged.push({ ...event, reason: 'micro_scene_merged' });
      continue;
    }
    accepted.push(event);
    cursor = event.timestamp;
  }
  if (accepted.length && total - accepted[accepted.length - 1].timestamp < minDuration) {
    merged.push({ ...accepted.pop(), reason: 'short_tail_merged' });
  }

  const expanded = [];
  let start = 0;
  for (const boundary of [...accepted, { timestamp: total, type: 'video_end', confidence: 1 }]) {
    const span = boundary.timestamp - start;
    const pieces = maxDuration > 0 ? Math.max(1, Math.ceil(span / maxDuration)) : 1;
    for (let index = 1; index < pieces; index++) {
      expanded.push({
        timestamp: roundTime(start + (span * index) / pieces),
        type: 'duration_split',
        confidence: 1,
      });
    }
    if (boundary.timestamp < total) expanded.push(boundary);
    start = boundary.timestamp;
  }
  const boundaries = [{ timestamp: 0, type: 'video_start', confidence: 1 }, ...expanded, {
    timestamp: total, type: 'video_end', confidence: 1,
  }];

  const scenes = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const left = boundaries[index];
    const right = boundaries[index + 1];
    scenes.push({
      sceneId: `scene_${String(index + 1).padStart(3, '0')}`,
      start: roundTime(left.timestamp),
      end: index === boundaries.length - 2 ? total : roundTime(right.timestamp),
      boundaryIn: { type: left.type, confidence: Number(left.confidence ?? 0) },
      boundaryOut: { type: right.type, confidence: Number(right.confidence ?? 0) },
      previewKeyframeId: null,
      keyframes: [],
      elements: [],
      metrics: { duration: roundTime(right.timestamp - left.timestamp) },
    });
  }
  validateScenes(scenes, total);
  return { scenes, rawBoundaries: candidates, mergedBoundaries: merged };
}

async function detectRawEvents(videoPath, options = {}) {
  const threshold = options.sceneThreshold ?? config.SCENE_THRESHOLD;
  const hardCut = await runFfmpeg([
    '-hide_banner', '-nostats', '-i', videoPath,
    '-vf', `select='gt(scene,${threshold})',metadata=print`,
    '-fps_mode', 'passthrough', '-an', '-f', 'null', '-',
  ]);
  const events = parseSceneEvents(hardCut.stderr).map((event) => ({
    ...event,
    type: 'hard_cut',
    signal: 'ffmpeg_scene_score',
  }));

  // A lower-threshold pass preserves weaker dissolve/composition evidence.
  // Canonical duration and dedupe rules keep continuous zoom/pan from
  // exploding into dropped or overlapping scenes.
  const secondaryThreshold = options.compositionThreshold ?? Math.max(0.1, threshold * 0.55);
  if (secondaryThreshold < threshold) {
    try {
      const secondary = await runFfmpeg([
        '-hide_banner', '-nostats', '-i', videoPath,
        '-vf', `select='gt(scene,${secondaryThreshold})',metadata=print`,
        '-fps_mode', 'passthrough', '-an', '-f', 'null', '-',
      ]);
      for (const event of parseSceneEvents(secondary.stderr)) {
        if (Number(event.score || 0) >= threshold) continue;
        events.push({
          ...event,
          type: 'dissolve_or_composition_change',
          signal: 'low_threshold_scene_score',
          confidence: Math.max(0.25, Math.min(0.8, Number(event.score || 0) / Math.max(threshold, 0.001))),
        });
      }
    } catch (error) {
      console.warn(`[scenes] secondary composition signal unavailable: ${error.message}`);
    }
  }

  // Black intervals are a cheap, deterministic fade signal. A canonical
  // boundary is placed at the interval midpoint and deduplicated with cuts.
  try {
    const black = await runFfmpeg([
      '-hide_banner', '-nostats', '-i', videoPath,
      '-vf', 'blackdetect=d=0.12:pic_th=0.96',
      '-an', '-f', 'null', '-',
    ]);
    for (const interval of parseBlackIntervals(black.stderr)) {
      events.push({
        timestamp: (interval.start + interval.end) / 2,
        type: 'fade',
        signal: 'black_interval',
        confidence: Math.max(0.5, Math.min(1, interval.duration / 0.6)),
        interval,
      });
    }
  } catch (error) {
    console.warn(`[scenes] fade detection unavailable: ${error.message}`);
  }

  if (options.enableMotionSignal !== false) {
    try {
      const sampleFps = Math.max(1, Math.min(12, Number(options.motionSampleFps || 4)));
      const motion = await runFfmpeg([
        '-hide_banner', '-nostats', '-i', videoPath,
        '-vf', `fps=${sampleFps},signalstats,metadata=print:key=lavfi.signalstats.YDIF`,
        '-an', '-f', 'null', '-',
      ]);
      events.push(...motionDiscontinuityEvents(parseMotionSamples(motion.stderr), options));
    } catch (error) {
      console.warn(`[scenes] motion discontinuity signal unavailable: ${error.message}`);
    }
  }
  return events;
}

async function createScenePreviews(jobId, videoPath, scenes) {
  for (const scene of scenes) {
    await artifactStore.initializeScene(jobId, scene.sceneId);
    const timestamp = Math.min(scene.end - 0.001, scene.start + Math.max(0.05, (scene.end - scene.start) / 2));
    const previewPath = path.join(artifactStore.sceneDir(jobId, scene.sceneId), 'preview.jpg');
    await extractFrame(videoPath, timestamp, previewPath, { maxEdgePx: 960, format: 'jpg' });
    if (fs.existsSync(previewPath)) scene.previewPath = previewPath;
  }
  return scenes;
}

async function detectScenes(jobId, videoPath, video, options = {}) {
  const events = options.rawEvents || await detectRawEvents(videoPath, options);
  const result = canonicalPartition(video.duration, events, options);
  if (options.createPreviews !== false) await createScenePreviews(jobId, videoPath, result.scenes);
  result.metrics = {
    rawBoundaryCount: events.length,
    canonicalBoundaryCount: Math.max(0, result.scenes.length - 1),
    mergedBoundaryCount: result.mergedBoundaries.length,
    boundaryEvidence: events
      .filter((event) => Number.isFinite(event.timestamp))
      .map(publicBoundaryEvidence),
    mergedBoundaryEvidence: result.mergedBoundaries.map(publicBoundaryEvidence),
    signals: events.reduce((counts, event) => ({
      ...counts,
      [event.signal || event.type || 'unknown']: (counts[event.signal || event.type || 'unknown'] || 0) + 1,
    }), {}),
  };
  return result;
}

module.exports = {
  dedupeBoundaries,
  boundaryPriority,
  publicBoundaryEvidence,
  parseMotionSamples,
  motionDiscontinuityEvents,
  canonicalPartition,
  detectRawEvents,
  createScenePreviews,
  detectScenes,
};
