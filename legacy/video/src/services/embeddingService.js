'use strict';

const crypto = require('crypto');

let providerOverride = null;

function localEmbedding(value, dimensions = 64) {
  const vector = new Array(dimensions).fill(0);
  const tokens = String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const token of tokens) {
    const digest = crypto.createHash('sha256').update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(2, token.length / 10));
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((valuePart) => valuePart / norm);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

async function embed(value, options = {}) {
  const provider = options.provider || providerOverride;
  if (!provider) {
    return { vector: localEmbedding(value), provider: { name: 'local-hashed-text', version: '1' } };
  }
  const result = await provider.embed({ text: String(value || '') });
  if (!Array.isArray(result?.vector) || result.vector.length === 0) {
    throw new Error('EmbeddingProvider returned an invalid vector');
  }
  return {
    vector: result.vector.map(Number),
    provider: result.provider || { name: 'custom-embedding', version: 'unknown' },
  };
}

function setProviderForTests(provider) { providerOverride = provider; }
function resetProviderForTests() { providerOverride = null; }

module.exports = {
  localEmbedding,
  cosineSimilarity,
  embed,
  setProviderForTests,
  resetProviderForTests,
};
