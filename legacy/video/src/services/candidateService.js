const fs = require('fs');
const path = require('path');

const config = require('../config');
const { updateJob } = require('./jobService');
const { runFfmpeg, parseFreezeDetect, parseSceneCuts, formatTimecode } = require('../utils/ffmpeg');
const { dhashFromFile, hamming, chromaFromFile, chromaDistance } = require('../utils/hash');
const { sharpnessFromFile } = require('../utils/sharpness');

function settingsWithDefaults(options = {}) {
  return {
    sampleFps: config.SAMPLE_FPS,
    minStillSec: config.MIN_ASSET_STILL_SEC,
    phashThreshold: config.PHASH_HAMMING_THRESHOLD,
    maxCandidates: config.MAX_CANDIDATES,
    freezeNoiseDb: config.FREEZE_NOISE_DB || '-50dB',
    fallbackToSceneCuts: config.FALLBACK_TO_SCENE_CUTS,
    sceneThreshold: config.SCENE_THRESHOLD ?? 0.3,
    maxSceneCandidates: config.MAX_SCENE_CANDIDATES ?? 25,
    ...options,
  };
}

async function recreateDirectory(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
}

async function sampleFrames(videoPath, jobId, onProgress, options = {}) {
  const settings = settingsWithDefaults(options);
  const dir = path.join(config.CANDIDATE_DIR, String(jobId), 'frames');
  await recreateDirectory(dir);
  const outputPattern = path.join(dir, 'f_%05d.png');
  const args = [
    '-y',
    '-hide_banner',
    '-nostats',
    '-loglevel', 'info',
    '-i', videoPath,
    '-vf', `fps=${settings.sampleFps}`,
    '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough',
    outputPattern,
  ];

  await runFfmpeg(args);
  if (onProgress) onProgress(1, 'sampling');

  const files = (await fs.promises.readdir(dir))
    .filter((file) => /^f_\d{5}\.png$/.test(file))
    .sort();

  return files.map((file, index) => ({
    path: path.join(dir, file),
    index: index + 1,
    timestamp: index / settings.sampleFps,
  }));
}

async function detectStillSpans(videoPath, options = {}) {
  const settings = settingsWithDefaults(options);
  const args = [
    '-hide_banner',
    '-nostats',
    '-i', videoPath,
    '-vf', `freezedetect=n=${settings.freezeNoiseDb}:d=${settings.minStillSec}`,
    '-map', '0:v:0',
    '-an', '-f', 'null', '-',
  ];
  const { stderr } = await runFfmpeg(args);
  return parseFreezeDetect(stderr);
}

async function detectSceneCuts(videoPath, options = {}) {
  const settings = settingsWithDefaults(options);
  const args = [
    '-hide_banner',
    '-nostats',
    '-i', videoPath,
    '-vf', `select='gt(scene,${settings.sceneThreshold})',metadata=print`,
    '-fps_mode', 'passthrough',
    '-an', '-f', 'null', '-',
  ];
  const { stderr } = await runFfmpeg(args);
  return parseSceneCuts(stderr);
}

function frameTimestampInAnySpan(timestamp, spans, toleranceSec = 0.5) {
  return spans.some((span) => (
    timestamp >= span.start - toleranceSec &&
    (span.end === Infinity || timestamp < span.end)
  ));
}

function spanCoverage(spans, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || spans.length === 0) return 0;
  const ranges = spans
    .map((span) => ({
      start: Math.max(0, span.start),
      end: Math.min(duration, Number.isFinite(span.end) ? span.end : duration),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let current = null;
  for (const range of ranges) {
    if (!current) {
      current = { ...range };
    } else if (range.start <= current.end) {
      current.end = Math.max(current.end, range.end);
    } else {
      total += current.end - current.start;
      current = { ...range };
    }
  }
  if (current) total += current.end - current.start;
  return total / duration;
}

function framesAfterCuts(frames, cuts, settings, duration) {
  const selected = [];
  const usedIndexes = new Set();
  const sortedCuts = cuts
    .map((cut) => (typeof cut === 'number' ? { timestamp: cut } : cut))
    .filter((cut) => Number.isFinite(cut.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, settings.maxSceneCandidates);

  for (const cut of sortedCuts) {
    const target = cut.timestamp + 1 / settings.sampleFps;
    const frame = frames.find((candidate) => (
      !usedIndexes.has(candidate.index) && candidate.timestamp >= target
    ));
    if (!frame) continue;
    usedIndexes.add(frame.index);
    selected.push({
      ...frame,
      span: {
        start: cut.timestamp,
        end: Math.min(duration, cut.timestamp + Math.max(1, 1 / settings.sampleFps)),
      },
    });
  }

  // Some continuous zoom/pan clips have no scene score above the threshold,
  // but the fallback still needs to produce a useful review frame. Seed it
  // with the first sample rather than silently returning an empty result.
  if (selected.length === 0 && frames.length > 0) {
    selected.push({
      ...frames[0],
      span: { start: 0, end: Math.min(duration, Math.max(1, 1 / settings.sampleFps)) },
    });
  }
  return selected;
}

function groupMeasuredFrames(measuredFrames, phashThreshold) {
  const groups = [];
  for (const measured of measuredFrames) {
    const last = groups[groups.length - 1];
    const sameDhash = last && hamming(last.representative.hash, measured.hash) <= phashThreshold;
    const sameChroma = last && (!last.representative.chroma || !measured.chroma ||
      chromaDistance(last.representative.chroma, measured.chroma) <= 0.12);
    if (last && sameDhash && sameChroma) {
      last.members.push(measured);
      last.span.start = Math.min(last.span.start, measured.span?.start ?? measured.timestamp);
      last.span.end = Math.max(last.span.end, measured.span?.end ?? measured.timestamp);
      if (measured.sharpness > last.representative.sharpness) {
        last.representative = measured;
        last.hash = measured.hash;
      }
    } else {
      groups.push({
        representative: measured,
        hash: measured.hash,
        members: [measured],
        span: {
          start: measured.span?.start ?? measured.timestamp,
          end: measured.span?.end ?? measured.timestamp,
        },
      });
    }
  }
  return groups;
}

async function findCandidates(job, videoPath, onProgress, options = {}) {
  const settings = settingsWithDefaults(options);
  const report = (pct, stage) => {
    if (onProgress) onProgress(Math.max(0, Math.min(1, pct)), stage);
  };

  updateJob(job.id, { status: 'sampling' });
  const frames = await sampleFrames(videoPath, job.id, (pct, stage) => {
    report(pct * 0.2, stage || 'sampling');
  }, settings);

  updateJob(job.id, { status: 'filtering' });
  report(0.2, 'filtering');
  const spans = await detectStillSpans(videoPath, settings);
  const duration = Number.isFinite(job.duration) && job.duration > 0
    ? job.duration
    : (frames.length > 0 ? frames[frames.length - 1].timestamp + 1 / settings.sampleFps : 0);
  const coverage = spanCoverage(spans, duration);
  let detectionMode = 'freeze';
  let inside = frames
    .filter((frame) => frameTimestampInAnySpan(frame.timestamp, spans))
    .map((frame) => ({
      ...frame,
      span: spans.find((span) => frameTimestampInAnySpan(frame.timestamp, [span])) || {
        start: frame.timestamp,
        end: frame.timestamp,
      },
    }));

  const shouldFallback = inside.length === 0 || spans.length < 2 || coverage < 0.03;
  if (shouldFallback && settings.fallbackToSceneCuts) {
    const cuts = await detectSceneCuts(videoPath, settings);
    inside = framesAfterCuts(frames, cuts, settings, duration);
    detectionMode = 'scene_fallback';
  }

  updateJob(job.id, { detectionMode });
  report(0.35, 'filtering');

  const measuredFrames = [];
  let scored = 0;
  for (const frame of inside) {
    let hash;
    try {
      hash = await dhashFromFile(frame.path);
    } catch (err) {
      // A single corrupt sample must not discard an otherwise valid video.
      continue;
    }

    let chroma;
    try {
      chroma = await chromaFromFile(frame.path);
    } catch (err) {
      chroma = null;
    }

    let sharpness = 0;
    try {
      sharpness = await sharpnessFromFile(frame.path);
    } catch (err) {
      // Keep a valid hashed frame usable, but let a healthy frame win scoring.
      sharpness = 0;
    }

    measuredFrames.push({ ...frame, hash, chroma, sharpness });

    scored++;
    report(0.35 + (inside.length ? (scored / inside.length) * 0.55 : 0), 'filtering');
  }

  const groups = groupMeasuredFrames(measuredFrames, settings.phashThreshold);
  const candidates = groups
    .sort((a, b) => a.members[0].timestamp - b.members[0].timestamp)
    .slice(0, settings.maxCandidates)
    .map((group) => {
      const representative = group.representative;
      return {
        path: representative.path,
        timestamp: representative.timestamp,
        timecode: formatTimecode(representative.timestamp),
        hash: representative.hash,
        sharpness: representative.sharpness,
        span: group.span,
        groupSize: group.members.length,
        frameIndexes: group.members.map((member) => member.index),
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  updateJob(job.id, {
    candidates,
    detectionMode,
  });
  report(1, 'filtering');
  return candidates;
}

module.exports = {
  sampleFrames,
  detectStillSpans,
  detectSceneCuts,
  frameTimestampInAnySpan,
  groupMeasuredFrames,
  findCandidates,
};
