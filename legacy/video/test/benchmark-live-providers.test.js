'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const benchmark = require('../scripts/benchmark-live-providers');

test('live provider benchmark defaults to dry-run with bounded budgets', () => {
  const options = benchmark.parseArgs([]);
  assert.equal(options.dryRun, true);
  assert.equal(options.confirmApiCost, false);
  assert.equal(options.maxScenes, 3);
  assert.equal(options.maxKeyframesPerScene, 3);
  assert.equal(options.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(options.maxApiRequests, 3);
});

test('live provider benchmark requires explicit cost confirmation and configured key', () => {
  const live = benchmark.parseArgs(['--live']);
  assert.throws(
    () => benchmark.assertLiveSafety(live, { apiKeyPresent: true }),
    /--confirm-api-cost/
  );
  const confirmed = benchmark.parseArgs(['--live', '--confirm-api-cost']);
  assert.throws(
    () => benchmark.assertLiveSafety(confirmed, { apiKeyPresent: false }),
    /ANTHROPIC_API_KEY/
  );
  assert.doesNotThrow(
    () => benchmark.assertLiveSafety(confirmed, { apiKeyPresent: true })
  );
});

test('benchmark output stays below test-results and labels pending review honestly', () => {
  const options = benchmark.parseArgs([
    '--run-label', '../../Unsafe Label',
    '--input-price-per-million-usd', '3',
    '--output-price-per-million-usd', '15',
  ]);
  const outputs = benchmark.outputPaths(options, new Date('2026-09-01T12:34:56.000Z'));
  assert.match(outputs.report.replaceAll('\\', '/'), /test-results\/live-providers\/20260901123456-Unsafe-Label\/report\.json$/);
  assert.equal(path.resolve(outputs.report).startsWith(path.resolve('test-results')), true);
  assert.equal(
    benchmark.isReviewedGroundTruth({ reviewStatus: 'pending-human-editor-review' }),
    false
  );
  assert.equal(
    benchmark.isReviewedGroundTruth({ reviewStatus: 'human-editor-reviewed' }),
    true
  );
  assert.deepEqual(
    benchmark.estimateCost(
      { input: 1_000_000, output: 100_000, cacheCreationInput: 0, cacheReadInput: 0 },
      options
    ),
    {
      estimatedUsd: 4.5,
      pricing: {
        source: 'user-supplied',
        inputPerMillionUsd: 3,
        outputPerMillionUsd: 15,
      },
      note: 'Estimate applies the supplied input price to all reported input/cache token categories.',
    }
  );
});

test('benchmark CLI rejects malformed caps and incomplete pricing', () => {
  assert.throws(
    () => benchmark.parseArgs(['--max-scenes', '0']),
    /--max-scenes/
  );
  assert.throws(
    () => benchmark.parseArgs(['--max-api-requests', '1.5']),
    /--max-api-requests/
  );
  assert.throws(
    () => benchmark.parseArgs(['--input-price-per-million-usd', '3']),
    /Both input and output/
  );
});
