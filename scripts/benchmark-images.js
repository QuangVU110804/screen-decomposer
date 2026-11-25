'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createConfig } = require('../src/config/index');
const { normalizeImage } = require('../src/features/images/normalize');
const { runWorker, engineStatus } = require('../src/integrations/python/worker');
const { atomicJson } = require('../src/shared/files');
async function main() {
  const config = createConfig();
  const input = process.argv[2]; const preset = process.argv[3] || 'fast';
  if (!input || !config.presets[preset]) throw new Error('Usage: npm run benchmark:images -- <image-path> [fast|balanced]');
  const status = await engineStatus(config);
  if (!status.ready) throw new Error(status.message);
  const dir = path.join(config.root, 'test-results/images', `${path.parse(input).name}-${preset}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  const image = await normalizeImage(await fs.readFile(input), dir, config);
  const output = path.join(dir, 'elements');
  const start = Date.now();
  const result = await runWorker(config, { source: image.source, output, preset, modelDir: config.modelDir, maxAssets: 80 }, {
    onEvent: e => { if (e.type === 'stage') console.log(`Stage: ${e.stage}`); },
  });
  const report = { input: path.basename(input), dimensions: [image.width, image.height], preset, wallMs: Date.now()-start,
    elementCount: result.elements.length, maskCount: result.elements.filter(e => e.outputKind === 'mask').length,
    textCropCount: result.elements.filter(e => e.outputKind === 'crop').length,
    engines: result.engines, timings: result.timings, warnings: result.warnings, engineFingerprint: status.fingerprint };
  await atomicJson(path.join(dir, 'report.json'), report);
  console.log(JSON.stringify(report, null, 2)); console.log(`Artifacts: ${dir}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
