'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const baseline = require('../scripts/benchmark-legacy-baseline');

test('legacy baseline CLI resolves safe defaults and restricts output to test-results', () => {
  const options = baseline.parseArgs([]);
  assert.match(options.groundTruthPath.replaceAll('\\', '/'), /test\/fixtures\/decomposer\/ground-truth\.json$/);
  assert.match(options.outputPath.replaceAll('\\', '/'), /test-results\/baselines\/legacy-frame\.json$/);
  assert.doesNotThrow(() => baseline.assertOutputPath(options.outputPath));
  assert.throws(
    () => baseline.assertOutputPath(path.resolve('legacy-report.json')),
    /test-results/
  );
});

test('legacy baseline CLI parses explicit fixture and output paths', () => {
  const options = baseline.parseArgs([
    '--fixture', 'temp/test-fixtures/decomposer/synthetic_decomposer_001.mp4',
    '--output', 'test-results/baselines/custom.json',
  ]);
  assert.match(options.fixturePath.replaceAll('\\', '/'), /synthetic_decomposer_001\.mp4$/);
  assert.match(options.outputPath.replaceAll('\\', '/'), /test-results\/baselines\/custom\.json$/);
  assert.throws(() => baseline.parseArgs(['--unknown']), /Unknown/);
});
