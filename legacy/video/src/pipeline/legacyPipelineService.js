'use strict';

const fs = require('fs');
const config = require('../config');
const { updateJob, getJob } = require('../services/jobService');
const { findCandidates } = require('../services/candidateService');
const visionService = require('../services/visionService');
const assetExtractionService = require('../services/assetExtractionService');
const clipService = require('../services/clipService');

async function runLegacyIngested(jobId, videoPath, duration) {
  updateJob(jobId, { status: 'sampling', stage: 'sampling', videoPath, duration, progress: 10 });
  const candidates = await findCandidates(getJob(jobId), videoPath, (pct, stage) => {
    updateJob(jobId, {
      progress: 10 + Math.round(pct * 25),
      ...(stage ? { stage } : {}),
    });
  });
  updateJob(jobId, { candidateCount: candidates.length });
  if (!config.ANTHROPIC_API_KEY) throw new Error(visionService.MISSING_KEY_ERROR);

  updateJob(jobId, { status: 'analyzing', stage: 'analyzing', progress: 35 });
  const verdicts = await visionService.classifyCandidates(candidates, (fraction) => {
    updateJob(jobId, { progress: 35 + Math.round(fraction * 50) });
  }, { jobId });
  const assets = verdicts.map((verdict) => ({
    label: verdict.label,
    description: verdict.description,
    confidence: verdict.confidence,
    timestamp: verdict.candidate.timestamp,
    timecode: verdict.candidate.timecode,
    framePath: verdict.candidate.path,
  }));
  const confirmed = assets.filter((asset) => Number(asset.confidence) > 0);
  updateJob(jobId, {
    status: 'finalizing',
    stage: 'finalizing',
    progress: 85,
    assets: confirmed,
    candidateCount: candidates.length,
  });

  const clipResult = await clipService.extractClips(
    jobId,
    videoPath,
    confirmed,
    duration,
    (pct) => updateJob(jobId, { progress: 85 + Math.round(pct * 5) })
  );
  updateJob(jobId, {
    assets: clipResult.assets,
    sceneClips: clipResult.clips,
    sceneClipCount: clipResult.clips.length,
    progress: 90,
  });

  await fs.promises.unlink(videoPath).catch(() => {});
  updateJob(jobId, { status: 'finalizing', stage: 'finalizing', progress: 92 });
  console.log(
    `[legacy job ${jobId}] vision: ${candidates.length} candidates -> ${confirmed.length} confirmed assets, ` +
    `${Math.ceil(candidates.length / config.VISION_BATCH_SIZE)} API calls, ${clipResult.clips.length} scene clips`
  );
  let finalized;
  try {
    finalized = await assetExtractionService.finalizeAssets(getJob(jobId));
  } catch (error) {
    throw new Error(`Lỗi khi hoàn tất asset: ${error.message}`);
  }
  updateJob(jobId, {
    assets: finalized.assets,
    sceneClips: finalized.sceneClips,
    status: 'done',
    stage: 'done',
    progress: 100,
  });
}

module.exports = { runLegacyIngested };
