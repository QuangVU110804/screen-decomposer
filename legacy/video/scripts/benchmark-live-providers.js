'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const AnthropicModule = require('@anthropic-ai/sdk');
const config = require('../src/config');
const artifactStore = require('../src/services/artifactStore');
const keyframeSelection = require('../src/services/keyframeSelectionService');
const sceneAnalysis = require('../src/services/sceneAnalysisService');
const { evaluate } = require('./evaluate-decomposer');

const Anthropic = AnthropicModule.default || AnthropicModule;
const ROOT = path.join(__dirname, '..');
const DEFAULT_GROUND_TRUTH = path.join(ROOT, 'test', 'fixtures', 'decomposer', 'ground-truth.json');
const REVIEWED_STATUSES = new Set(['human-editor-reviewed', 'reviewed', 'approved']);

function usage() {
  return [
    'Usage:',
    '  node scripts/benchmark-live-providers.js [options]',
    '',
    'Safe default: dry-run. A paid request is possible only with BOTH --live and --confirm-api-cost.',
    '',
    'Options:',
    '  --dry-run                         Plan the run without extracting frames or calling providers (default)',
    '  --live                            Run Anthropic scene analysis',
    '  --confirm-api-cost                Mandatory acknowledgment for --live',
    '  --ground-truth <path>             Ground-truth JSON',
    '  --video <path>                    Override the video path declared by ground truth',
    '  --run-label <label>               Sanitized label used under test-results/live-providers/',
    '  --max-scenes <n>                  Maximum scenes to analyze (default: 3)',
    '  --max-keyframes-per-scene <n>     Maximum keyframes per scene (default: 3)',
    '  --max-image-bytes <n>             Maximum total prepared JPEG bytes (default: 8388608)',
    '  --max-api-requests <n>             Hard request cap, including all scenes (default: 3)',
    '  --input-price-per-million-usd <n> Optional user-supplied input-token price',
    '  --output-price-per-million-usd <n> Optional user-supplied output-token price',
    '  --help                            Show this message',
  ].join('\n');
}

function integerOption(value, name, { min = 1 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return number;
}

function priceOption(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a finite number >= 0`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    dryRun: true,
    confirmApiCost: false,
    groundTruthPath: DEFAULT_GROUND_TRUTH,
    videoPath: null,
    runLabel: null,
    maxScenes: 3,
    maxKeyframesPerScene: 3,
    maxImageBytes: 8 * 1024 * 1024,
    maxApiRequests: 3,
    inputPricePerMillionUsd: null,
    outputPricePerMillionUsd: null,
    help: false,
  };

  function next(index, flag) {
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--live') options.dryRun = false;
    else if (arg === '--confirm-api-cost') options.confirmApiCost = true;
    else if (arg === '--ground-truth') options.groundTruthPath = path.resolve(next(index++, arg));
    else if (arg === '--video') options.videoPath = path.resolve(next(index++, arg));
    else if (arg === '--run-label') options.runLabel = next(index++, arg);
    else if (arg === '--max-scenes') options.maxScenes = integerOption(next(index++, arg), arg);
    else if (arg === '--max-keyframes-per-scene') {
      options.maxKeyframesPerScene = integerOption(next(index++, arg), arg);
    } else if (arg === '--max-image-bytes') {
      options.maxImageBytes = integerOption(next(index++, arg), arg);
    } else if (arg === '--max-api-requests') {
      options.maxApiRequests = integerOption(next(index++, arg), arg);
    } else if (arg === '--input-price-per-million-usd') {
      options.inputPricePerMillionUsd = priceOption(next(index++, arg), arg);
    } else if (arg === '--output-price-per-million-usd') {
      options.outputPricePerMillionUsd = priceOption(next(index++, arg), arg);
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  const hasInputPrice = options.inputPricePerMillionUsd !== null;
  const hasOutputPrice = options.outputPricePerMillionUsd !== null;
  if (hasInputPrice !== hasOutputPrice) {
    throw new Error('Both input and output token prices must be supplied together');
  }
  return options;
}

function sanitizeLabel(value) {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return sanitized || 'benchmark';
}

function portableSourcePath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(ROOT, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replaceAll(path.sep, '/');
  }
  return path.basename(resolved);
}

function outputPaths(options, now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const mode = options.dryRun ? 'dry-run' : 'live';
  const label = sanitizeLabel(options.runLabel || mode);
  const directory = path.join(ROOT, 'test-results', 'live-providers', `${stamp}-${label}`);
  const outputRoot = path.resolve(ROOT, 'test-results');
  const resolved = path.resolve(directory);
  if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error('Benchmark output escaped test-results');
  }
  return {
    directory: resolved,
    prediction: path.join(resolved, 'prediction.json'),
    report: path.join(resolved, 'report.json'),
  };
}

function loadGroundTruth(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const video = payload.videos?.[0];
  if (!video || !Array.isArray(video.scenes) || video.scenes.length === 0) {
    throw new Error('Ground truth must contain videos[0].scenes');
  }
  return payload;
}

function resolveVideoPath(options, groundTruth) {
  if (options.videoPath) return options.videoPath;
  const declared = groundTruth.dataset?.video;
  if (!declared) return null;
  return path.resolve(ROOT, declared);
}

function assertLiveSafety(options, { apiKeyPresent }) {
  if (options.dryRun) return;
  if (!options.confirmApiCost) {
    throw new Error('Refusing live provider calls without --confirm-api-cost');
  }
  if (!apiKeyPresent) {
    throw new Error('Refusing live run because ANTHROPIC_API_KEY is not configured');
  }
}

function isReviewedGroundTruth(groundTruth) {
  return REVIEWED_STATUSES.has(String(groundTruth.reviewStatus || '').toLowerCase());
}

function buildPlan(options, groundTruth, videoPath) {
  const sourceScenes = groundTruth.videos[0].scenes;
  const sceneCount = Math.min(sourceScenes.length, options.maxScenes, options.maxApiRequests);
  return {
    mode: options.dryRun ? 'dry-run' : 'live',
    provider: 'anthropic',
    model: config.VISION_MODEL,
    groundTruth: portableSourcePath(options.groundTruthPath),
    video: videoPath ? portableSourcePath(videoPath) : null,
    videoExists: Boolean(videoPath && fs.existsSync(videoPath)),
    totalGroundTruthScenes: sourceScenes.length,
    plannedScenes: sceneCount,
    skippedBySceneOrRequestCap: sourceScenes.length - sceneCount,
    plannedMaximumKeyframes: sceneCount * options.maxKeyframesPerScene,
    caps: {
      maxScenes: options.maxScenes,
      maxKeyframesPerScene: options.maxKeyframesPerScene,
      maxImageBytes: options.maxImageBytes,
      maxApiRequests: options.maxApiRequests,
    },
  };
}

function usageTokens(usageValue) {
  const usage = usageValue || {};
  return {
    input: Number(usage.input_tokens || usage.inputTokens || 0),
    output: Number(usage.output_tokens || usage.outputTokens || 0),
    cacheCreationInput: Number(usage.cache_creation_input_tokens || 0),
    cacheReadInput: Number(usage.cache_read_input_tokens || 0),
  };
}

function estimateCost(tokens, options) {
  if (
    options.inputPricePerMillionUsd === null ||
    options.outputPricePerMillionUsd === null
  ) {
    return {
      estimatedUsd: null,
      pricing: null,
      note: 'Token usage is recorded, but cost is not estimated until both user-supplied prices are provided.',
    };
  }
  const billableInput = tokens.input + tokens.cacheCreationInput + tokens.cacheReadInput;
  const estimatedUsd =
    (billableInput / 1_000_000) * options.inputPricePerMillionUsd +
    (tokens.output / 1_000_000) * options.outputPricePerMillionUsd;
  return {
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    pricing: {
      source: 'user-supplied',
      inputPerMillionUsd: options.inputPricePerMillionUsd,
      outputPerMillionUsd: options.outputPricePerMillionUsd,
    },
    note: 'Estimate applies the supplied input price to all reported input/cache token categories.',
  };
}

function redactMessage(error) {
  let message = String(error?.message || error || 'Unknown provider error');
  const secrets = [
    config.ANTHROPIC_API_KEY,
    process.env.SEGMENTER_API_KEY,
    process.env.INPAINTER_API_KEY,
  ].filter((value) => typeof value === 'string' && value.length >= 8);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  return message
    .replace(/(authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 1000);
}

async function callAnthropic(client, scene, prepared) {
  const started = Date.now();
  const message = await client.messages.create({
    model: config.VISION_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: sceneAnalysis.SYSTEM_PROMPT,
    tools: [sceneAnalysis.REPORT_SCENE_TOOL],
    tool_choice: { type: 'tool', name: sceneAnalysis.REPORT_SCENE_TOOL.name },
    messages: [{ role: 'user', content: prepared.content }],
  }, { timeout: config.CLAUDE_TIMEOUT_MS });
  const tool = message.content?.find((block) => (
    block.type === 'tool_use' && block.name === sceneAnalysis.REPORT_SCENE_TOOL.name
  ));
  if (!tool) throw new Error('Scene analyzer did not return report_scene_elements');
  return {
    input: tool.input,
    usage: usageTokens(message.usage),
    latencyMs: Date.now() - started,
  };
}

function publicElements(scene) {
  return (scene.elements || []).map((element) => ({
    elementId: element.elementId,
    type: element.type,
    description: element.description,
    extractability: element.extractability,
    semanticConfidence: element.semanticConfidence,
    localizationConfidence: element.localizationConfidence,
    observations: (element.observations || []).map((observation) => ({
      keyframeId: observation.keyframeId,
      bbox: observation.bbox,
      ...(observation.corners ? { corners: observation.corners } : {}),
      visibility: observation.visibility,
      occlusion: observation.occlusion,
      motion: observation.motion,
    })),
  }));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function runLive(options, groundTruth, videoPath, plan) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('Live benchmark video is missing; run npm.cmd run fixtures:decomposer or pass --video');
  }
  const sourceVideo = groundTruth.videos[0];
  const selected = sourceVideo.scenes.slice(0, plan.plannedScenes);
  const benchmarkJobId = `benchmark-${randomUUID()}`;
  const predictionScenes = [];
  const sceneRuns = [];
  const totals = {
    apiRequests: 0,
    keyframes: 0,
    imageBytes: 0,
    latencyMs: 0,
    tokens: { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
  };
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  try {
    for (const sourceScene of selected) {
      if (totals.apiRequests >= options.maxApiRequests) break;
      const scene = {
        sceneId: sourceScene.sceneId,
        start: Number(sourceScene.start),
        end: Number(sourceScene.end),
        keyframes: [],
        elements: [],
        metrics: {},
      };
      const sceneRun = {
        sceneId: scene.sceneId,
        status: 'pending',
        keyframes: 0,
        imageBytes: 0,
        apiRequests: 0,
        latencyMs: 0,
        tokens: { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
      };
      let requestStartedAt = null;
      try {
        await keyframeSelection.selectForScene(benchmarkJobId, videoPath, scene, {
          keyframesPerScene: options.maxKeyframesPerScene,
          maxKeyframesPerScene: options.maxKeyframesPerScene,
          proxyMaxEdgePx: config.VISION_MAX_EDGE_PX,
        });
        sceneRun.keyframes = scene.keyframes.length;
        totals.keyframes += scene.keyframes.length;
        const prepared = await sceneAnalysis.buildContent(scene);
        sceneRun.imageBytes = prepared.bytes;
        if (totals.imageBytes + prepared.bytes > options.maxImageBytes) {
          sceneRun.status = 'skipped-image-byte-cap';
          sceneRun.error = 'Prepared image payload would exceed --max-image-bytes';
          sceneRuns.push(sceneRun);
          continue;
        }
        totals.imageBytes += prepared.bytes;
        totals.apiRequests++;
        sceneRun.apiRequests = 1;
        requestStartedAt = Date.now();
        const response = await callAnthropic(client, scene, prepared);
        sceneAnalysis.normalizeAnalysis(response.input, scene);
        sceneRun.status = 'complete';
        sceneRun.latencyMs = response.latencyMs;
        sceneRun.tokens = response.usage;
        totals.latencyMs += response.latencyMs;
        for (const key of Object.keys(totals.tokens)) {
          totals.tokens[key] += response.usage[key];
        }
        predictionScenes.push({
          sceneId: scene.sceneId,
          start: scene.start,
          end: scene.end,
          keyframes: scene.keyframes.map((keyframe) => ({
            keyframeId: keyframe.keyframeId,
            timestamp: keyframe.timestamp,
            selectionReason: keyframe.selectionReason,
          })),
          elements: publicElements(scene),
        });
      } catch (error) {
        if (requestStartedAt !== null && sceneRun.latencyMs === 0) {
          sceneRun.latencyMs = Date.now() - requestStartedAt;
          totals.latencyMs += sceneRun.latencyMs;
        }
        sceneRun.status = 'failed';
        sceneRun.error = redactMessage(error);
      }
      sceneRuns.push(sceneRun);
    }
  } finally {
    const benchmarkRoot = path.resolve(artifactStore.jobDir(benchmarkJobId));
    const jobsRoot = path.resolve(config.JOB_DIR);
    if (benchmarkRoot.startsWith(`${jobsRoot}${path.sep}`)) {
      await artifactStore.removeJobArtifacts(benchmarkJobId).catch(() => {});
    }
  }

  return {
    prediction: {
      schemaVersion: 1,
      benchmarkMode: 'live',
      provider: { name: 'anthropic', model: config.VISION_MODEL },
      videos: [{
        videoId: sourceVideo.videoId || 'benchmark_video',
        duration: sourceVideo.duration,
        scenes: predictionScenes,
        assets: [],
      }],
    },
    sceneRuns,
    totals,
  };
}

function buildReport({
  options,
  groundTruth,
  plan,
  outputs,
  execution,
  generatedAt,
}) {
  const reviewed = isReviewedGroundTruth(groundTruth);
  const dryRun = options.dryRun;
  const prediction = execution?.prediction || {
    schemaVersion: 1,
    benchmarkMode: 'dry-run',
    status: 'not-executed',
    videos: [],
  };
  const metrics = dryRun ? null : evaluate(groundTruth, prediction);
  const totals = execution?.totals || {
    apiRequests: 0,
    keyframes: 0,
    imageBytes: 0,
    latencyMs: 0,
    tokens: { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0 },
  };
  const cost = estimateCost(totals.tokens, options);
  const thresholds = groundTruth.thresholds || {};
  const automatedMetricPass = Boolean(metrics) &&
    metrics.elements.precision >= Number(thresholds.elementPrecision || 0) &&
    metrics.elements.recall >= Number(thresholds.elementRecall || 0) &&
    metrics.elements.meanIou >= Number(thresholds.bboxIou || 0);
  const sceneRuns = execution?.sceneRuns || [];
  const executionComplete = !dryRun &&
    sceneRuns.length === plan.plannedScenes &&
    sceneRuns.every((scene) => scene.status === 'complete');
  const resultStatus = dryRun
    ? 'dry-run-only'
    : sceneRuns.some((scene) => scene.status === 'failed')
      ? 'completed-with-failures'
      : sceneRuns.some((scene) => scene.status !== 'complete')
        ? 'completed-with-skips'
        : 'completed';

  return {
    schemaVersion: 1,
    generatedAt,
    mode: plan.mode,
    status: resultStatus,
    plan,
    execution: {
      apiRequests: totals.apiRequests,
      keyframes: totals.keyframes,
      preparedImageBytes: totals.imageBytes,
      totalLatencyMs: totals.latencyMs,
      averageLatencyMsPerRequest: totals.apiRequests
        ? Number((totals.latencyMs / totals.apiRequests).toFixed(2))
        : null,
      tokens: totals.tokens,
      cost,
      scenes: sceneRuns,
    },
    evaluation: {
      reviewStatus: groundTruth.reviewStatus || 'unspecified',
      reviewedGroundTruth: reviewed,
      metrics,
      automatedMetricPass,
      releaseGateClaimed: reviewed && executionComplete && automatedMetricPass,
      claim: reviewed
        ? 'Metrics may be considered against the reviewed benchmark thresholds.'
        : `No reviewed-result claim is made while ground truth status is "${groundTruth.reviewStatus || 'unspecified'}".`,
    },
    outputs: {
      prediction: portableSourcePath(outputs.prediction),
      report: portableSourcePath(outputs.report),
    },
    safety: {
      paidCallsRequireLiveAndConfirmation: true,
      confirmationReceived: options.confirmApiCost,
      apiKeyRecorded: false,
      rawRequestsRecorded: false,
      providerRequestIdsRecorded: false,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    assertLiveSafety(options, { apiKeyPresent: Boolean(config.ANTHROPIC_API_KEY) });
    const groundTruth = loadGroundTruth(options.groundTruthPath);
    const videoPath = resolveVideoPath(options, groundTruth);
    const plan = buildPlan(options, groundTruth, videoPath);
    const outputs = outputPaths(options);
    const generatedAt = new Date().toISOString();
    const execution = options.dryRun
      ? null
      : await runLive(options, groundTruth, videoPath, plan);
    const prediction = execution?.prediction || {
      schemaVersion: 1,
      benchmarkMode: 'dry-run',
      status: 'not-executed',
      videos: [],
    };
    const report = buildReport({
      options,
      groundTruth,
      plan,
      outputs,
      execution,
      generatedAt,
    });
    writeJson(outputs.prediction, prediction);
    writeJson(outputs.report, report);
    console.log(JSON.stringify(report, null, 2));
    if (!options.dryRun && report.status === 'completed-with-failures') return 1;
    return 0;
  } catch (error) {
    console.error(redactMessage(error));
    console.error('Run with --help for usage.');
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  usage,
  parseArgs,
  sanitizeLabel,
  outputPaths,
  assertLiveSafety,
  isReviewedGroundTruth,
  buildPlan,
  usageTokens,
  estimateCost,
  redactMessage,
  buildReport,
  main,
};
