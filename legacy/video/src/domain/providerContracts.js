'use strict';

const CONTRACTS = Object.freeze({
  SceneDetector: ['detectScenes'],
  KeyframeSelector: ['selectKeyframes'],
  SceneAnalyzer: ['analyzeScene'],
  Segmenter: ['segment'],
  Inpainter: ['inpaint'],
  OcrEngine: ['recognize'],
  EmbeddingProvider: ['embed'],
  AssetValidator: ['validate'],
});

function assertProvider(contractName, provider) {
  const methods = CONTRACTS[contractName];
  if (!methods) throw new Error(`Unknown provider contract: ${contractName}`);
  if (!provider || typeof provider !== 'object') {
    throw new Error(`${contractName} provider must be an object`);
  }
  for (const method of methods) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`${contractName} provider must implement ${method}()`);
    }
  }
  return provider;
}

class ProviderRegistry {
  constructor(initial = {}) {
    this.providers = new Map();
    for (const [contractName, provider] of Object.entries(initial)) {
      this.register(contractName, provider);
    }
  }

  register(contractName, provider) {
    this.providers.set(contractName, assertProvider(contractName, provider));
    return this;
  }

  get(contractName, { optional = false } = {}) {
    const provider = this.providers.get(contractName);
    if (!provider && !optional) throw new Error(`No provider registered for ${contractName}`);
    return provider || null;
  }
}

module.exports = { CONTRACTS, assertProvider, ProviderRegistry };
