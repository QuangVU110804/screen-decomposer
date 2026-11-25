'use strict';

let providerOverride = null;

function fallbackResult(element) {
  return {
    content: String(element.text || ''),
    confidence: Math.max(0, Math.min(1, Number(element.semanticConfidence || 0))),
    style: element.textStyle || null,
    provider: { name: 'scene-analyzer-text', version: '1' },
    fallback: true,
  };
}

async function recognizeElement(element, context = {}, options = {}) {
  const provider = options.provider || providerOverride;
  if (!provider) return fallbackResult(element);
  try {
    const result = await provider.recognize({ element, ...context });
    return {
      content: String(result?.content || element.text || ''),
      confidence: Math.max(0, Math.min(1, Number(result?.confidence || 0))),
      style: result?.style || element.textStyle || null,
      provider: result?.provider || { name: 'custom-ocr', version: 'unknown' },
      fallback: false,
    };
  } catch (error) {
    return {
      ...fallbackResult(element),
      error: error.message,
    };
  }
}

function setProviderForTests(provider) { providerOverride = provider; }
function resetProviderForTests() { providerOverride = null; }

module.exports = {
  fallbackResult,
  recognizeElement,
  setProviderForTests,
  resetProviderForTests,
};
