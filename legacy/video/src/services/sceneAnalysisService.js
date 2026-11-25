'use strict';

const fs = require('fs');
const AnthropicModule = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const config = require('../config');
const artifactStore = require('./artifactStore');
const { withRetry } = require('./visionService');
const {
  ELEMENT_TYPES,
  EXTRACTABILITY,
  clamp01,
  validateBbox,
  validateCorners,
  validateElements,
} = require('../domain/decomposerSchema');

const Anthropic = AnthropicModule.default || AnthropicModule;
const MISSING_KEY_ERROR = 'Thiếu ANTHROPIC_API_KEY — scene và keyframe đã được giữ lại nhưng chưa thể nhận diện element.';

const SYSTEM_PROMPT = `You analyze a chronological set of keyframes from ONE video scene for a video editor.
Identify reusable visual elements, including person, character, background, image, screenshot, text and graphic.
Do not reject people, ordinary footage or backgrounds by default. Report only spatially localizable elements.
Group the same element across keyframes into one element with multiple observations. Bboxes are normalized
[x,y,width,height] from the top-left. Distinguish standalone overlay text from text that merely belongs inside
a screenshot or image. For a tilted rectangular screenshot/image, optionally report corners in TL,TR,BR,BL order.
Choose extractability: direct for rectangular source crops, segmentable for foregrounds,
requires_inpainting for occluded backgrounds, and not_extractable when evidence is insufficient.`;

const REPORT_SCENE_TOOL = {
  name: 'report_scene_elements',
  description: 'Report reusable elements observed across all keyframes in this scene.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...ELEMENT_TYPES] },
            description: { type: 'string' },
            extractability: { type: 'string', enum: [...EXTRACTABILITY] },
            semanticConfidence: { type: 'number' },
            localizationConfidence: { type: 'number' },
            text: { type: 'string' },
            textStyle: {
              type: 'object',
              properties: {
                color: { type: 'string' }, alignment: { type: 'string' }, weight: { type: 'string' },
              },
            },
            observations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  keyframeRef: { type: 'integer' },
                  bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
                  corners: {
                    type: 'array',
                    minItems: 4,
                    maxItems: 4,
                    items: {
                      type: 'array',
                      minItems: 2,
                      maxItems: 2,
                      items: { type: 'number' },
                    },
                    description: 'Optional quadrilateral in TL,TR,BR,BL order for a tilted rectangular element.',
                  },
                  visibility: { type: 'number' },
                  occlusion: { type: 'number' },
                  motion: { type: 'number' },
                },
                required: ['keyframeRef', 'bbox', 'visibility', 'occlusion', 'motion'],
              },
            },
          },
          required: ['type', 'description', 'extractability', 'semanticConfidence', 'localizationConfidence', 'observations'],
        },
      },
    },
    required: ['summary', 'elements'],
  },
};

let providerOverride = null;

async function prepare(filePath) {
  const prepared = await sharp(filePath, { failOn: 'none' })
    .resize({ width: config.VISION_MAX_EDGE_PX, height: config.VISION_MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: config.VISION_JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    data: prepared.data.toString('base64'),
    bytes: prepared.data.length,
    pixels: prepared.info.width * prepared.info.height,
    width: prepared.info.width,
    height: prepared.info.height,
  };
}

async function buildContent(scene, options = {}) {
  const content = [{
    type: 'text',
    text: `Scene ${scene.sceneId}, canonical range [${scene.start}, ${scene.end}). Keyframes are chronological.`,
  }];
  const maxImageBytes = Number(
    options.maxImageBytes ?? config.MAX_VISION_IMAGE_BYTES_PER_SCENE
  );
  const maxImagePixels = Number(
    options.maxImagePixels ?? config.MAX_VISION_PIXELS_PER_SCENE
  );
  let bytes = 0;
  let pixels = 0;
  for (let index = 0; index < scene.keyframes.length; index++) {
    const keyframe = scene.keyframes[index];
    const image = await prepare(keyframe.path);
    if (bytes + image.bytes > maxImageBytes) {
      const error = new Error(
        `${scene.sceneId} Vision payload ${bytes + image.bytes} bytes vượt budget ${maxImageBytes} bytes`
      );
      error.code = 'VISION_IMAGE_BUDGET_EXCEEDED';
      error.sceneId = scene.sceneId;
      error.imageBytes = bytes + image.bytes;
      error.maxImageBytes = maxImageBytes;
      throw error;
    }
    if (pixels + image.pixels > maxImagePixels) {
      const error = new Error(
        `${scene.sceneId} Vision payload ${pixels + image.pixels} pixels vượt budget ${maxImagePixels} pixels`
      );
      error.code = 'VISION_PIXEL_BUDGET_EXCEEDED';
      error.sceneId = scene.sceneId;
      error.imagePixels = pixels + image.pixels;
      error.maxImagePixels = maxImagePixels;
      throw error;
    }
    bytes += image.bytes;
    pixels += image.pixels;
    content.push({ type: 'text', text: `Keyframe ref ${index}: ${keyframe.keyframeId} at ${keyframe.timestamp}s` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } });
  }
  content.push({ type: 'text', text: 'Use report_scene_elements exactly once. keyframeRef must refer to the numbered keyframe above.' });
  return { content, bytes, pixels };
}

function normalizeAnalysis(input, scene) {
  const values = Array.isArray(input?.elements) ? input.elements : [];
  const elements = [];
  for (const value of values) {
    const type = ELEMENT_TYPES.has(value?.type) ? value.type : 'unknown';
    const extractability = EXTRACTABILITY.has(value?.extractability) ? value.extractability : 'not_extractable';
    const observations = [];
    const seenRefs = new Set();
    for (const observation of Array.isArray(value?.observations) ? value.observations : []) {
      const ref = Number(observation?.keyframeRef);
      if (!Number.isInteger(ref) || ref < 0 || ref >= scene.keyframes.length || seenRefs.has(ref)) continue;
      try {
        const normalized = {
          keyframeId: scene.keyframes[ref].keyframeId,
          bbox: validateBbox(observation.bbox),
          visibility: clamp01(observation.visibility),
          occlusion: clamp01(observation.occlusion),
          motion: clamp01(observation.motion),
        };
        if (observation.corners !== undefined) normalized.corners = validateCorners(observation.corners);
        observations.push(normalized);
        seenRefs.add(ref);
      } catch (_error) {
        // A malformed observation is isolated instead of invalidating the scene.
      }
    }
    if (observations.length === 0) continue;
    const number = elements.length + 1;
    elements.push({
      elementId: `element_${scene.sceneId.slice(6)}_${String(number).padStart(2, '0')}`,
      trackId: null,
      type,
      description: typeof value.description === 'string' ? value.description.trim().slice(0, 500) : '',
      extractability,
      semanticConfidence: clamp01(value.semanticConfidence),
      localizationConfidence: clamp01(value.localizationConfidence),
      text: typeof value.text === 'string' ? value.text.trim().slice(0, 2000) : '',
      textStyle: value.textStyle && typeof value.textStyle === 'object' ? {
        color: String(value.textStyle.color || '').slice(0, 64),
        alignment: String(value.textStyle.alignment || '').slice(0, 32),
        weight: String(value.textStyle.weight || '').slice(0, 32),
      } : null,
      observations,
      assetIds: [],
    });
  }
  const result = {
    summary: typeof input?.summary === 'string' ? input.summary.trim().slice(0, 1000) : '',
    elements,
  };
  scene.elements = elements;
  validateElements(scene);
  return result;
}

async function anthropicAnalyze(scene, options = {}) {
  if (!config.ANTHROPIC_API_KEY) throw new Error(MISSING_KEY_ERROR);
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const prepared = await buildContent(scene, options);
  const message = await client.messages.create({
    model: config.VISION_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [REPORT_SCENE_TOOL],
    tool_choice: { type: 'tool', name: REPORT_SCENE_TOOL.name },
    messages: [{ role: 'user', content: prepared.content }],
  }, { timeout: config.CLAUDE_TIMEOUT_MS });
  const tool = message.content?.find((block) => block.type === 'tool_use' && block.name === REPORT_SCENE_TOOL.name);
  if (!tool) throw new Error('Scene analyzer did not return report_scene_elements');
  return {
    input: tool.input,
    audit: {
      provider: 'anthropic',
      model: config.VISION_MODEL,
      requestId: message.id || null,
      usage: message.usage || null,
      imageBytes: prepared.bytes,
      imagePixels: prepared.pixels,
    },
  };
}

async function analyzeScene(jobId, scene, options = {}) {
  const provider = options.provider || providerOverride;
  const started = Date.now();
  const call = provider
    ? () => provider.analyzeScene(scene)
    : () => anthropicAnalyze(scene, options);
  const response = await withRetry(call, { retries: options.retries });
  const input = response?.input || response;
  const result = normalizeAnalysis(input, scene);
  const audit = {
    ...(response?.audit || {
      provider: provider ? 'custom' : 'anthropic',
      model: config.VISION_MODEL,
    }),
    latencyMs: Number(response?.audit?.latencyMs || (Date.now() - started)),
  };
  scene.analysis = { summary: result.summary, status: 'complete', provider: audit };
  await artifactStore.writeJsonAtomic(
    require('path').join(artifactStore.sceneDir(jobId, scene.sceneId), 'analysis.json'),
    { schemaVersion: 2, sceneId: scene.sceneId, ...result, provider: audit }
  );
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    jobId,
    sceneId: scene.sceneId,
    stage: 'understanding_scenes',
    event: 'scene_analysis_completed',
    provider: audit.provider || audit.name || 'unknown',
    model: audit.model || audit.version || 'unknown',
    latencyMs: audit.latencyMs,
    imageBytes: Number(audit.imageBytes || 0),
    imagePixels: Number(audit.imagePixels || 0),
    inputTokens: Number(audit.usage?.input_tokens || audit.usage?.inputTokens || 0),
    outputTokens: Number(audit.usage?.output_tokens || audit.usage?.outputTokens || 0),
    elementCount: result.elements.length,
  }));
  return scene;
}

async function analyzeScenes(jobId, scenes, onProgress, options = {}) {
  const failures = [];
  for (let index = 0; index < scenes.length; index++) {
    try {
      await analyzeScene(jobId, scenes[index], options);
    } catch (error) {
      scenes[index].elements = [];
      scenes[index].analysis = { status: 'failed', error: error.message };
      const code = error.code || 'SCENE_ANALYSIS_FAILED';
      failures.push({ sceneId: scenes[index].sceneId, code, message: error.message });
      console.warn(JSON.stringify({
        time: new Date().toISOString(),
        jobId,
        sceneId: scenes[index].sceneId,
        stage: 'understanding_scenes',
        event: 'scene_analysis_failed',
        code,
        message: error.message,
      }));
    }
    if (onProgress) onProgress((index + 1) / scenes.length, scenes[index]);
  }
  return { scenes, failures };
}

function setProviderForTests(provider) { providerOverride = provider; }
function resetProviderForTests() { providerOverride = null; }

module.exports = {
  SYSTEM_PROMPT,
  REPORT_SCENE_TOOL,
  MISSING_KEY_ERROR,
  buildContent,
  normalizeAnalysis,
  analyzeScene,
  analyzeScenes,
  setProviderForTests,
  resetProviderForTests,
};
