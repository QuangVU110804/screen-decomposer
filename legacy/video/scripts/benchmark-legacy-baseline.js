'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { createJob, getJob, removeJob } = require('../src/services/jobService');
const legacyPipeline = require('../src/pipeline/legacyPipelineService');
const vision = require('../src/services/visionService');
const { directorySize } = require('../src/pipeline/pipelineService');

const ROOT = path.join(__dirname, '..');
const DEFAULT_GROUND_TRUTH = path.join(
  ROOT,
  'test',
  'fixtures',
  'decomposer',
  'ground-truth.json'
);
const DEFAULT_OUTPUT = path.join(
  ROOT,
  'test-results',
  'baselines',
  'legacy-frame.json'
);

function parseArgs(argv) {
  const options = {
    groundTruthPath: DEFAULT_GROUND_TRUTH,
    fixturePath: null,
    outputPath: DEFAULT_OUTPUT,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--ground-truth' && value) {
      options.groundTruthPath = path.resolve(value);
      index++;
    } else if (arg === '--fixture' && value) {
      options.fixturePath = path.resolve(value);
      index++;
    } else if (arg === '--output' && value) {
      options.outputPath = path.resolve(value);
      index++;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return options;
}

function assertOutputPath(filePath) {
  const outputRoot = path.resolve(ROOT, 'test-results');
  const resolved = path.resolve(filePath);
  if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error('Baseline output must stay under test-results');
  }
  return resolved;
}

function fixtureFromGroundTruth(options) {
  if (options.fixturePath) return options.fixturePath;
  const truth = JSON.parse(fs.readFileSync(options.groundTruthPath, 'utf8'));
  if (!truth.dataset?.video) throw new Error('Ground truth does not declare dataset.video');
  return path.resolve(ROOT, truth.dataset.video);
}

function publicPath(filePath) {
  const relative = path.relative(ROOT, path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, '/')
    : path.basename(filePath);
}

async function runBaseline(options) {
  const fixturePath = fixtureFromGroundTruth(options);
  if (!fs.existsSync(fixturePath)) {
    throw new Error('Missing legacy baseline fixture. Run: npm.cmd run fixtures:decomposer');
  }
  const outputPath = assertOutputPath(options.outputPath);
  const jobId = `legacy-baseline-${Date.now()}`;
  const videoPath = path.join(config.VIDEO_DIR, `${jobId}.mp4`);
  const previousKey = config.ANTHROPIC_API_KEY;
  let apiCalls = 0;
  let imagesSent = 0;
  const startedAt = Date.now();

  await fs.promises.mkdir(config.VIDEO_DIR, { recursive: true });
  await fs.promises.copyFile(fixturePath, videoPath);
  createJob(jobId, {
    schemaVersion: 1,
    resultType: 'legacy-frame',
    legacyFrameResult: true,
    sourceType: 'fixture',
  });
  config.ANTHROPIC_API_KEY = 'mock-baseline-key';
  vision.setClientForTests({
    messages: {
      create: async (params) => {
        apiCalls++;
        const count = params.messages[0].content.filter((block) => block.type === 'image').length;
        imagesSent += count;
        return {
          content: [{
            type: 'tool_use',
            name: 'report_assets',
            input: {
              assets: Array.from({ length: count }, (_unused, ref) => ({
                ref,
                isAsset: true,
                label: 'Legacy full frame',
                description: 'Deterministic legacy baseline output',
                confidence: 0.9,
              })),
            },
          }],
        };
      },
    },
  });

  try {
    const truth = JSON.parse(fs.readFileSync(options.groundTruthPath, 'utf8'));
    const duration = Number(truth.videos?.[0]?.duration || 0);
    await legacyPipeline.runLegacyIngested(jobId, videoPath, duration);
    const job = getJob(jobId);
    const assetRoot = path.join(config.ASSET_DIR, jobId);
    const candidateRoot = path.join(config.CANDIDATE_DIR, jobId);
    const diskBytes =
      await directorySize(assetRoot) +
      await directorySize(candidateRoot);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      benchmarkMode: 'deterministic-mock-provider',
      source: publicPath(fixturePath),
      legacyArchitecture: {
        canonicalScenePartition: false,
        multiKeyframeSceneUnderstanding: false,
        elementLocalization: false,
        segmentationOrReconstruction: false,
        crossSceneIdentity: false,
      },
      measurements: {
        status: job.status,
        candidateCount: Number(job.candidateCount || 0),
        assetCount: Number(job.assets?.length || 0),
        fullFrameOutputCount: Number(job.assets?.length || 0),
        fullFrameOutputRatio: job.assets?.length ? 1 : 0,
        visionApiCalls: apiCalls,
        visionImagesSent: imagesSent,
        elapsedMs: Date.now() - startedAt,
        diskBytes,
      },
      provider: {
        name: 'mock',
        version: 'legacy-baseline-v1',
        paidCalls: 0,
      },
      limitations: [
        'Semantic quality is not measured because the provider is deterministic mock Vision.',
        'Scene/element/bbox/mask metrics are structurally unavailable from the legacy job model.',
      ],
    };
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
    return { report, outputPath };
  } finally {
    vision.resetClientForTests();
    config.ANTHROPIC_API_KEY = previousKey;
    removeJob(jobId);
    await fs.promises.rm(path.join(config.ASSET_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(path.join(config.CANDIDATE_DIR, jobId), { recursive: true, force: true });
    await fs.promises.rm(videoPath, { force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const { report, outputPath } = await runBaseline(options);
    console.log(JSON.stringify({
      ...report,
      output: publicPath(outputPath),
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(`Legacy baseline failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  parseArgs,
  assertOutputPath,
  fixtureFromGroundTruth,
  publicPath,
  runBaseline,
  main,
};
