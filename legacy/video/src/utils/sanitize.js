'use strict';

const WINDOWS_ABSOLUTE_PATH = /[a-z]:[\\/](?:[^\\/\r\n:*?"<>|]+[\\/])*[^\\/\r\n\s"'<>|]+/gi;
const UNIX_ABSOLUTE_PATH = /\/(?:home|Users|tmp|var|opt|workspace|mnt|private|Volumes)\/[^\r\n"'<>]+/g;
const PROVIDER_URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
const ANTHROPIC_KEY = /\bsk-ant-[a-z0-9_-]+\b/gi;
const BEARER_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]+\b/gi;
const PROVIDER_REQUEST_ID = /\b(?:req|request|msg)_[a-z0-9_-]{8,}\b/gi;

function sanitizePublicMessage(value, maxLength = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .replace(/\0/g, '')
    .replace(ANTHROPIC_KEY, '[redacted-key]')
    .replace(BEARER_TOKEN, 'Bearer [redacted-token]')
    .replace(PROVIDER_REQUEST_ID, '[provider-request-id]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[internal-path]')
    .replace(UNIX_ABSOLUTE_PATH, '[internal-path]')
    .replace(PROVIDER_URL, '[provider-url]')
    .trim();
  return text.slice(0, maxLength);
}

function sanitizePublicFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const result = {};
  for (const key of ['sceneId', 'elementId', 'assetId', 'stage', 'code']) {
    if (failure[key] !== undefined && failure[key] !== null) {
      result[key] = String(failure[key]).slice(0, 160);
    }
  }
  result.message = sanitizePublicMessage(failure.message || 'Unknown failure');
  return result;
}

module.exports = {
  sanitizePublicMessage,
  sanitizePublicFailure,
};
