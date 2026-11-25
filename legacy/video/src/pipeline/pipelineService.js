'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const artifactStore = require('../services/artifactStore');
const { getVideoInfo } = require('../utils/videoInfo');
const { makeManifest, validateManifest } = require('../domain/decomposerSchema');
const { getJobOrThrow, updateJob } = require('../services/jobService');
const sceneDetection = require('../services/sceneDetectionService');
const keyframeSelection = require('../services/keyframeSelectionService');
const sceneAnalysis = require('../services/sceneAnalysisService');
const { associateElements } = require('../services/elementAssociationService');
const directExtraction = require('../services/directExtractionService');
const segmentation = require('../services/segmentationService');
const backgroundRecovery = require('../services/backgroundRecoveryService');
const quality = require('../services/assetQualityService');
const deduplication = require('../services/assetDeduplicationService');
const packageService = require('../services/packageService');
const { progressFor } = require('./stageRegistry');

function logEvent(jobId, stage, event, details = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    jobId,
    stage,
    event,
    ...details,
  }));
}

function mergeMetrics(target, patch) {
  return { ...(target || {}), ...(patch || {}) };
}

async function directorySize(root) {
  if (!root || !fs.existsSync(root)) return 0;
  let total = 0;
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(fullPath);
    else if (entry.isFile()) total += (await fs.promises.stat(fullPath)).size;
  }
  return total;
}

async function jobDiskUsage(jobId) {
  let total = await directorySize(artifactStore.jobDir(jobId));
  const finalPack = path.join(config.ASSET_DIR, String(jobId));
  total += await directorySize(finalPack);
  if (fs.existsSync(config.ASSET_DIR)) {
    const prefix = `.staging-v2-${jobId}-`;
    const entries = await fs.promises.readdir(config.ASSET_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        total += await directorySize(path.join(config.ASSET_DIR, entry.name));
      }
    }
  }
  return total;
}

function resourceError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function createResourceBudgetGuard(job, startedAt = Date.now(), options = {}) {
  const maxDiskBytes = Number(
    options.maxJobDiskBytes ??
    ((options.maxJobDiskMb ?? config.MAX_JOB_DISK_MB) * 1024 * 1024)
  );
  const maxRuntimeMs = Number(
    options.maxPipelineRuntimeMs ??
    ((options.maxPipelineRuntimeSec ?? config.MAX_PIPELINE_RUNTIME_SEC) * 1000)
  );
  if (!Number.isFinite(maxDiskBytes) || maxDiskBytes <= 0) {
    throw new Error('maxJobDiskBytes must be positive');
  }
  if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) {
    throw new Error('maxPipelineRuntimeMs must be positive');
  }
  let peakDiskBytes = 0;

  async function assertWithinBudget(stage, checkpoint) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const diskBytes = await jobDiskUsage(job.id);
    peakDiskBytes = Math.max(peakDiskBytes, diskBytes);
    job.metrics = mergeMetrics(job.metrics, {
      resources: {
        maxJobDiskBytes: Math.round(maxDiskBytes),
        maxPipelineRuntimeMs: Math.round(maxRuntimeMs),
        currentDiskBytes: diskBytes,
        peakDiskBytes,
        elapsedMs,
        lastCheckedStage: stage,
        lastCheckpoint: checkpoint,
      },
    });
    if (elapsedMs > maxRuntimeMs) {
      throw resourceError(
        'PIPELINE_RUNTIME_BUDGET_EXCEEDED',
        `Pipeline runtime ${elapsedMs}ms vượt budget ${Math.round(maxRuntimeMs)}ms`,
        { stage, checkpoint, elapsedMs, maxRuntimeMs }
      );
    }
    if (diskBytes > maxDiskBytes) {
      throw resourceError(
        'JOB_DISK_BUDGET_EXCEEDED',
        `Job disk usage ${diskBytes} bytes vượt budget ${Math.round(maxDiskBytes)} bytes`,
        { stage, checkpoint, diskBytes, maxDiskBytes }
      );
    }
    return job.metrics.resources;
  }

  return {
    maxDiskBytes,
    maxRuntimeMs,
    assertWithinBudget,
  };
}

function sceneAnalysisMetrics(scenes, failures) {
  const complete = scenes.filter((scene) => scene.analysis?.status === 'complete');
  const usage = complete.reduce((totals, scene) => {
    const audit = scene.analysis?.provider || {};
    const providerUsage = audit.usage || {};
    return {
      inputTokens: totals.inputTokens + Number(providerUsage.input_tokens || providerUsage.inputTokens || 0),
      outputTokens: totals.outputTokens + Number(providerUsage.output_tokens || providerUsage.outputTokens || 0),
      imageBytes: totals.imageBytes + Number(audit.imageBytes || 0),
      imagePixels: totals.imagePixels + Number(audit.imagePixels || 0),
    };
  }, { inputTokens: 0, outputTokens: 0, imageBytes: 0, imagePixels: 0 });
  return {
    completedScenes: complete.length,
    failedScenes: failures?.length || 0,
    ...usage,
  };
}

async function persistState(job) {
  const state = {
    schemaVersion: 2,
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    video: job.video,
    scenes: job.scenes,
    tracks: job.tracks,
    assets: job.assets,
    failures: job.failures,
    metrics: job.metrics,
  };
  await artifactStore.writeJsonAtomic(path.join(artifactStore.jobDir(job.id), 'pipeline-state.json'), state);
}

function sync(job, patch) {
  Object.assign(job, patch);
  const persisted = updateJob(job.id, patch);
  if (persisted) job.updatedAt = persisted.updatedAt;
  return job;
}

async function runStage(job, stage, fn, resourceGuard = null) {
  if (resourceGuard) await resourceGuard.assertWithinBudget(stage, 'before');
  const started = Date.now();
  const progress = (fraction, patch = {}) => {
    sync(job, {
      status: stage,
      stage,
      progress: progressFor(stage, fraction),
      ...patch,
    });
  };
  progress(0);
  logEvent(job.id, stage, 'started');
  const result = await fn(progress);
  if (resourceGuard) await resourceGuard.assertWithinBudget(stage, 'after');
  const elapsedMs = Date.now() - started;
  job.metrics = {
    ...(job.metrics || {}),
    stages: {
      ...(job.metrics?.stages || {}),
      [stage]: { elapsedMs },
    },
  };
  progress(1, { metrics: job.metrics });
  await persistState(job);
  logEvent(job.id, stage, 'completed', { elapsedMs });
  return result;
}

function appendFailures(job, failures) {
  if (!failures?.length) return;
  job.failures = [...(job.failures || []), ...failures];
}

async function extractAssets(job, options = {}, resourceGuard = null) {
  for (const scene of job.scenes) {
    for (const element of scene.elements || []) element.assetIds = [];
  }
  let nextIndex = 1;
  const direct = await runStage(job, 'extracting_direct_assets', async (progress) => (
    directExtraction.extractDirectAssets(
      job.id,
      job.scenes,
      nextIndex,
      (fraction) => progress(fraction)
    )
  ), resourceGuard);
  nextIndex = direct.nextIndex;
  appendFailures(job, direct.failures);
  job.assets = direct.assets;
  sync(job, { scenes: job.scenes, assets: job.assets, failures: job.failures });

  const segmented = await runStage(job, 'segmenting', async (progress) => (
    segmentation.segmentAssets(
      job.id,
      job.scenes,
      nextIndex,
      (fraction) => progress(fraction),
      options.segmentation || {}
    )
  ), resourceGuard);
  nextIndex = segmented.nextIndex;
  appendFailures(job, segmented.failures);
  job.assets.push(...segmented.assets);
  sync(job, { scenes: job.scenes, assets: job.assets, failures: job.failures });

  const backgrounds = await runStage(job, 'recovering_backgrounds', async (progress) => (
    backgroundRecovery.recoverBackgrounds(
      job.id,
      job.scenes,
      job.assets,
      nextIndex,
      (fraction) => progress(fraction),
      options.backgroundRecovery || {}
    )
  ), resourceGuard);
  appendFailures(job, backgrounds.failures);
  job.assets.push(...backgrounds.assets);
  job.metrics = mergeMetrics(job.metrics, {
    backgroundRecoverySkipped: backgrounds.skipped?.length || 0,
    extraction: {
      direct: direct.assets.length,
      segmented: segmented.assets.filter((asset) => asset.extractionMode === 'SEGMENTED').length,
      reconstructed: backgrounds.assets.filter((asset) => asset.extractionMode === 'RECONSTRUCTED').length,
      failed: [...segmented.assets, ...backgrounds.assets].filter((asset) => asset.extractionMode === 'FAILED').length,
      segmentationBudget: config.MAX_SEGMENTATION_CALLS,
      maxInpaintAreaRatio: config.MAX_INPAINT_AREA_RATIO,
    },
  });
  sync(job, { scenes: job.scenes, assets: job.assets, failures: job.failures, metrics: job.metrics });
}

async function validateAndPackage(job, options = {}, resourceGuard = null) {
  const validation = await runStage(job, 'validating_assets', async (progress) => (
    quality.scoreAndValidateAssets(job.assets, job.scenes, (fraction) => progress(fraction))
  ), resourceGuard);
  job.assets = validation.assets;
  appendFailures(job, validation.failures);
  sync(job, { assets: job.assets, failures: job.failures });

  const deduped = await runStage(job, 'deduplicating', async (progress) => {
    const result = await deduplication.deduplicateAssets(job.assets, job.scenes, options.dedupe || {});
    progress(1);
    return result;
  }, resourceGuard);
  job.assets = deduped.assets;
  job.metrics = mergeMetrics(job.metrics, { dedupe: deduped.metrics });
  sync(job, { scenes: job.scenes, assets: job.assets, metrics: job.metrics });

  const packaged = await runStage(job, 'packaging', async (progress) => {
    validateManifest({
      schemaVersion: 2,
      videoId: job.id,
      video: job.video,
      scenes: job.scenes,
      tracks: job.tracks,
      assets: job.assets,
    }, { requireKeyframes: true });
    progress(0.2);
    const packaged = await packageService.packageJob(job);
    progress(1);
    return packaged;
  }, resourceGuard);
  job.metrics = mergeMetrics(job.metrics, {
    package: {
      outputBytes: await directorySize(packaged.outputDir),
      sceneCount: job.scenes.length,
      assetCount: job.assets.length,
    },
  });
  sync(job, {
    scenes: job.scenes,
    assets: job.assets,
    manifestPath: artifactStore.manifestPath(job.id),
    metrics: job.metrics,
  });
}

async function runDecomposer(jobId, inputPath, options = {}) {
  const pipelineStarted = Date.now();
  const job = getJobOrThrow(jobId);
  if (Number(job.schemaVersion) !== 2) throw new Error('runDecomposer chỉ nhận job schema v2');
  job.failures = [];
  job.metrics = { ...(job.metrics || {}), pipelineVersion: 2 };
  const resourceGuard = createResourceBudgetGuard(
    job,
    pipelineStarted,
    options.resourceBudgets || {}
  );

  try {
    await runStage(job, 'probing', async (progress) => {
      await artifactStore.initialize(job.id);
      const sourcePath = await artifactStore.adoptSource(job.id, inputPath);
      progress(0.35, { videoPath: sourcePath });
      const video = await getVideoInfo(sourcePath);
      if (video.duration > config.MAX_VIDEO_DURATION_SEC) {
        throw new Error(
          `Video dài ${Math.round(video.duration)}s, vượt giới hạn ${config.MAX_VIDEO_DURATION_SEC}s`
        );
      }
      const manifest = makeManifest(job.id, video);
      job.videoPath = sourcePath;
      job.video = manifest.video;
      job.duration = manifest.video.duration;
      job.scenes = [];
      job.tracks = [];
      job.assets = [];
      sync(job, {
        videoPath: sourcePath,
        video: job.video,
        duration: job.duration,
        scenes: [],
        tracks: [],
        assets: [],
        failures: [],
        metrics: job.metrics,
      });
      progress(1);
    }, resourceGuard);

    const detected = await runStage(job, 'detecting_scenes', async (progress) => {
      const result = await sceneDetection.detectScenes(job.id, job.videoPath, job.video, options.sceneDetection || {});
      progress(1);
      return result;
    }, resourceGuard);
    if (detected.scenes.length > config.MAX_SCENES) {
      const error = new Error(`Video có ${detected.scenes.length} scene, vượt budget MAX_SCENES=${config.MAX_SCENES}`);
      error.code = 'MAX_SCENES_EXCEEDED';
      throw error;
    }
    job.scenes = detected.scenes;
    job.metrics = mergeMetrics(job.metrics, { sceneDetection: detected.metrics });
    sync(job, { scenes: job.scenes, metrics: job.metrics });

    const selected = await runStage(job, 'selecting_keyframes', async (progress) => (
      keyframeSelection.selectKeyframes(
        job.id,
        job.videoPath,
        job.scenes,
        (fraction) => progress(fraction),
        options.keyframes || {}
      )
    ), resourceGuard);
    job.scenes = selected.scenes;
    job.metrics = mergeMetrics(job.metrics, { keyframes: selected.metrics });
    sync(job, { scenes: job.scenes, metrics: job.metrics });

    const analyzed = await runStage(job, 'understanding_scenes', async (progress) => (
      sceneAnalysis.analyzeScenes(
        job.id,
        job.scenes,
        (fraction) => progress(fraction),
        options.sceneAnalysis || {}
      )
    ), resourceGuard);
    job.scenes = analyzed.scenes;
    appendFailures(job, analyzed.failures);
    job.metrics = mergeMetrics(job.metrics, {
      sceneAnalysis: sceneAnalysisMetrics(job.scenes, analyzed.failures),
    });
    sync(job, { scenes: job.scenes, failures: job.failures, metrics: job.metrics });

    await runStage(job, 'associating_elements', async (progress) => {
      job.tracks = associateElements(job.scenes, options.association || {});
      progress(1);
    }, resourceGuard);
    sync(job, { scenes: job.scenes, tracks: job.tracks });

    await extractAssets(job, options, resourceGuard);
    await validateAndPackage(job, options, resourceGuard);

    const usableAssets = job.assets.filter((asset) => asset.qualityState !== 'failed').length;
    const terminalStatus = job.failures.length > 0 ? 'partial' : 'done';
    sync(job, {
      status: terminalStatus,
      stage: terminalStatus,
      progress: 100,
      assetCount: usableAssets,
      sceneCount: job.scenes.length,
      completedAt: new Date().toISOString(),
      metrics: mergeMetrics(job.metrics, { totalElapsedMs: Date.now() - pipelineStarted }),
    });
    await persistState(job);
    logEvent(job.id, terminalStatus, 'pipeline_finished', {
      scenes: job.scenes.length,
      assets: job.assets.length,
      usableAssets,
      failures: job.failures.length,
    });
    return job;
  } catch (error) {
    appendFailures(job, [{
      stage: job.stage,
      code: error.code || 'PIPELINE_FAILED',
      message: error.message,
    }]);
    sync(job, {
      status: 'failed',
      stage: 'failed',
      error: error.message,
      failures: job.failures,
      metrics: job.metrics,
    });
    await persistState(job).catch(() => {});
    logEvent(job.id, job.stage, 'pipeline_failed', { code: error.code || 'PIPELINE_FAILED', message: error.message });
    return job;
  }
}

async function reanalyzeScene(jobId, sceneId, options = {}) {
  const pipelineStarted = Date.now();
  const job = getJobOrThrow(jobId);
  if (Number(job.schemaVersion) !== 2) throw new Error('Chỉ job v2 mới hỗ trợ re-analyze scene');
  const scene = job.scenes.find((item) => item.sceneId === sceneId);
  if (!scene) throw new Error(`Không tìm thấy scene ${sceneId}`);
  if (!job.videoPath || !fs.existsSync(job.videoPath)) {
    throw new Error('Source video không còn tồn tại; không thể re-analyze scene');
  }
  const resourceGuard = createResourceBudgetGuard(
    job,
    pipelineStarted,
    options.resourceBudgets || {}
  );
  const snapshot = {
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    scenes: JSON.parse(JSON.stringify(job.scenes || [])),
    tracks: JSON.parse(JSON.stringify(job.tracks || [])),
    assets: JSON.parse(JSON.stringify(job.assets || [])),
    failures: JSON.parse(JSON.stringify(job.failures || [])),
    metrics: JSON.parse(JSON.stringify(job.metrics || {})),
    assetCount: job.assetCount,
    sceneCount: job.sceneCount,
    completedAt: job.completedAt,
  };
  try {
    job.failures = (job.failures || []).filter((failure) => failure.sceneId !== sceneId);
    await runStage(job, 'understanding_scenes', async (progress) => {
      await sceneAnalysis.analyzeScene(job.id, scene, options.sceneAnalysis || {});
      progress(1);
    }, resourceGuard);
    await runStage(job, 'associating_elements', async (progress) => {
      job.tracks = associateElements(job.scenes, options.association || {});
      progress(1);
    }, resourceGuard);
    for (const current of job.scenes) {
      await fs.promises.rm(artifactStore.assetDir(job.id, current.sceneId), { recursive: true, force: true });
      await fs.promises.mkdir(artifactStore.assetDir(job.id, current.sceneId), { recursive: true });
    }
    job.assets = [];
    sync(job, { scenes: job.scenes, tracks: job.tracks, assets: [], failures: job.failures });
    await extractAssets(job, options, resourceGuard);
    await validateAndPackage(job, options, resourceGuard);
    const terminalStatus = job.failures.length > 0 ? 'partial' : 'done';
    const usableAssets = job.assets.filter((asset) => asset.qualityState !== 'failed').length;
    sync(job, {
      status: terminalStatus,
      stage: terminalStatus,
      progress: 100,
      error: null,
      assetCount: usableAssets,
      sceneCount: job.scenes.length,
      completedAt: new Date().toISOString(),
      metrics: mergeMetrics(job.metrics, {
        lastReanalysisElapsedMs: Date.now() - pipelineStarted,
      }),
    });
    await persistState(job);
    return job;
  } catch (error) {
    const failure = {
      sceneId,
      stage: job.stage,
      code: error.code || 'SCENE_REANALYSIS_FAILED',
      message: error.message,
    };
    const failures = [
      ...snapshot.failures.filter((item) => item.sceneId !== sceneId),
      failure,
    ];
    sync(job, {
      status: 'partial',
      stage: 'partial',
      progress: 100,
      error: null,
      scenes: snapshot.scenes,
      tracks: snapshot.tracks,
      assets: snapshot.assets,
      failures,
      assetCount: snapshot.assetCount,
      sceneCount: snapshot.sceneCount,
      completedAt: snapshot.completedAt,
      metrics: mergeMetrics(snapshot.metrics, {
        lastReanalysis: {
          sceneId,
          status: 'failed',
          code: failure.code,
          elapsedMs: Date.now() - pipelineStarted,
        },
      }),
    });
    await persistState(job).catch(() => {});
    logEvent(job.id, 'partial', 'scene_reanalysis_failed', failure);
    return job;
  }
}

module.exports = {
  logEvent,
  directorySize,
  jobDiskUsage,
  createResourceBudgetGuard,
  runStage,
  runDecomposer,
  reanalyzeScene,
};
