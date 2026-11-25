const AnthropicModule = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const config = require('../config');
const { formatTimecode } = require('../utils/ffmpeg');

const Anthropic = AnthropicModule.default || AnthropicModule;

const SYSTEM_PROMPT = `You analyze still frames sampled from a video. Your job is to identify which frames show
an INSERTED VISUAL ASSET — a photo, product image, screenshot, chart, diagram, slide, or
graphic that was deliberately placed into the video as distinct content — as opposed to
ordinary footage of the video itself (a person talking, a webcam feed, a screen recording
of normal browsing/scrolling with no distinct still shown, blank/transition frames, or
plain background).

For each frame you are given:
- If it IS an inserted asset: set isAsset=true, give a short human label (2-5 words,
  e.g. "iPhone product photo", "Revenue chart", "Login screenshot") and a one-sentence
  description of what's shown.
- If it is NOT (ordinary footage, blur, transition, blank/solid color, webcam) set
  isAsset=false with an empty label.

Be conservative: a frame of a person's face, a plain background, or generic B-roll is
NOT an asset even if it is visually distinct from surrounding frames. Only flag content
that looks like it was deliberately inserted as a discrete visual (a still image, a chart,
a document, a UI screenshot).`;

const REPORT_ASSETS_TOOL = {
  name: 'report_assets',
  description: 'Report classification results for every frame in this batch.',
  input_schema: {
    type: 'object',
    properties: {
      assets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'integer', description: '0-based frame index within this batch' },
            isAsset: { type: 'boolean' },
            label: { type: 'string', description: '2-5 word human label; empty string if isAsset=false' },
            description: { type: 'string', description: 'one sentence; empty string if isAsset=false' },
            confidence: { type: 'number', description: '0 to 1' },
          },
          required: ['ref', 'isAsset', 'label', 'description', 'confidence'],
        },
      },
    },
    required: ['assets'],
  },
};

const MISSING_KEY_ERROR = 'Thiếu ANTHROPIC_API_KEY — không thể phân tích ảnh bằng Vision. Thêm key vào .env.';
let clientOverride = null;

function getClient() {
  if (clientOverride) return clientOverride;
  if (!config.ANTHROPIC_API_KEY) throw new Error(MISSING_KEY_ERROR);
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
}

async function prepareImageForVision(filePath) {
  const buffer = await sharp(filePath, { failOn: 'none' })
    .resize({
      width: config.VISION_MAX_EDGE_PX,
      height: config.VISION_MAX_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.VISION_JPEG_QUALITY })
    .toBuffer();
  return {
    base64: buffer.toString('base64'),
    mediaType: 'image/jpeg',
    bytes: buffer.length,
  };
}

function buildContent(batch) {
  const content = [];
  batch.forEach((candidate, index) => {
    const timecode = candidate.timecode || formatTimecode(candidate.timestamp || 0);
    content.push({ type: 'text', text: `Frame ${index} — timestamp ${timecode}` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: candidate._mediaType || 'image/jpeg',
        data: candidate._b64,
      },
    });
  });
  content.push({
    type: 'text',
    text: `Classify all ${batch.length} frames above using report_assets. Use "ref" equal to the Frame number (0-based) shown before each image.`,
  });
  return content;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function validateVerdicts(input, batchLength) {
  let values = input;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch (err) {
      return [];
    }
  }
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const valid = [];
  for (const value of values) {
    if (!value || !Number.isInteger(value.ref) || value.ref < 0 || value.ref >= batchLength) continue;
    if (seen.has(value.ref)) continue;
    seen.add(value.ref);
    valid.push({
      ref: value.ref,
      isAsset: value.isAsset === true,
      label: typeof value.label === 'string' ? value.label.trim() : '',
      description: typeof value.description === 'string' ? value.description.trim() : '',
      confidence: clampConfidence(value.confidence),
    });
  }
  return valid;
}

async function classifyBatch(batch, client = getClient()) {
  const message = await client.messages.create({
    model: config.VISION_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [REPORT_ASSETS_TOOL],
    tool_choice: { type: 'tool', name: 'report_assets' },
    messages: [{ role: 'user', content: buildContent(batch) }],
  }, { timeout: config.CLAUDE_TIMEOUT_MS });

  const blocks = Array.isArray(message?.content) ? message.content : [];
  const toolUse = blocks.find((block) => block.type === 'tool_use' && block.name === 'report_assets');
  if (!toolUse) throw new Error('Claude did not return a report_assets tool call');
  const input = toolUse.input && !Array.isArray(toolUse.input)
    ? toolUse.input.assets
    : toolUse.input;
  const verdicts = validateVerdicts(input, batch.length);
  if (Array.isArray(input) && verdicts.length !== input.length) {
    console.warn(`[vision] ignored malformed or duplicate refs (${input.length - verdicts.length})`);
  }
  if (!Array.isArray(input) || verdicts.length !== batch.length) {
    console.warn(`[vision] incomplete report: got ${verdicts.length}/${batch.length} valid refs`);
  }
  return verdicts;
}

function isRetryable(error) {
  return error?.status === 429
    || (error?.status >= 500 && error?.status < 600)
    || error?.name === 'APIConnectionTimeoutError'
    || error?.name === 'APIConnectionError'
    || !error?.status;
}

async function withRetry(fn, { retries = config.VISION_MAX_RETRIES, baseMs = 500, sleep } = {}) {
  let lastError;
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      const delay = baseMs * (2 ** attempt) + Math.random() * 200;
      await wait(delay);
    }
  }
  throw lastError;
}

function stripPrepared(candidate) {
  const clean = { ...candidate };
  delete clean._b64;
  delete clean._mediaType;
  delete clean._bytes;
  return clean;
}

async function classifyCandidates(candidates, onProgress, options = {}) {
  if (!Array.isArray(candidates)) throw new Error('Vision candidates must be an array');
  const client = options.client || getClient();
  if (candidates.length > config.MAX_CANDIDATES) {
    console.warn(
      `[vision] candidates (${candidates.length}) exceed MAX_CANDIDATES (${config.MAX_CANDIDATES}) — ` +
      'this should not happen, truncating defensively'
    );
    candidates = candidates.slice(0, config.MAX_CANDIDATES);
  }
  if (candidates.length === 0) {
    if (onProgress) onProgress(1);
    console.log(`[vision][job ${options.jobId || 'unknown'}] images_sent=0 api_calls=0 confirmed_assets=0`);
    return [];
  }

  // Prepare once before batching so retries reuse the exact same JPEG buffers.
  const prepared = await Promise.all(candidates.map(async (candidate) => {
    const image = await prepareImageForVision(candidate.path);
    return {
      ...candidate,
      _b64: image.base64,
      _mediaType: image.mediaType,
      _bytes: image.bytes,
    };
  }));

  const batches = chunk(prepared, options.batchSize || config.VISION_BATCH_SIZE);
  const results = [];
  let failedBatches = 0;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    try {
      const verdicts = await withRetry(
        () => classifyBatch(batch, client),
        {
          retries: options.retries,
          baseMs: options.baseMs,
          sleep: options.sleep,
        }
      );
      for (const verdict of verdicts) {
        const candidate = batch[verdict.ref];
        if (candidate) {
          results.push({ candidate: stripPrepared(candidate), ...verdict });
        }
      }
    } catch (err) {
      failedBatches++;
      console.warn(`Vision batch ${index + 1}/${batches.length} failed after retries: ${err.message}`);
    }
    if (onProgress) onProgress((index + 1) / batches.length);
  }

  if (failedBatches > 0) {
    console.warn(`[vision] ${failedBatches}/${batches.length} batch(es) failed; keeping partial results`);
  }
  const assets = results.filter((result) => result.isAsset === true);
  console.log(
    `[vision][job ${options.jobId || 'unknown'}] images_sent=${candidates.length} ` +
    `api_calls=${batches.length} confirmed_assets=${assets.length}`
  );
  return assets;
}

function setClientForTests(client) {
  clientOverride = client;
}

function resetClientForTests() {
  clientOverride = null;
}

module.exports = {
  SYSTEM_PROMPT,
  REPORT_ASSETS_TOOL,
  MISSING_KEY_ERROR,
  prepareImageForVision,
  buildContent,
  validateVerdicts,
  classifyBatch,
  withRetry,
  classifyCandidates,
  setClientForTests,
  resetClientForTests,
};
