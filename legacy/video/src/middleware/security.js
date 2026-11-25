// Rate limiting (per-IP) for write endpoints + optional API-key auth.
// When API_KEY env var is empty, auth is disabled (local/dev).
const config = require('../config');

// --- Rate limiting (lightweight implementation, no extra deps) ---
const buckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket || now - bucket.start > config.RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }

  bucket.count++;

  if (bucket.count > config.RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Quá nhiều yêu cầu, vui lòng thử lại sau',
      retryAfterMs: config.RATE_LIMIT_WINDOW_MS - (now - bucket.start),
    });
  }

  next();
}

// Periodically purge stale buckets to prevent unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - config.RATE_LIMIT_WINDOW_MS;
  for (const [ip, bucket] of buckets) {
    if (bucket.start < cutoff) buckets.delete(ip);
  }
}).unref();

// --- Optional API-key auth ---
function requireApiKey(req, res, next) {
  if (!config.API_KEY) return next(); // auth disabled
  // Deliberately reject query-string credentials: URLs are commonly retained
  // in browser history, reverse-proxy logs and analytics.
  const key = req.headers['x-api-key'];
  if (!key || key !== config.API_KEY) {
    return res.status(401).json({
      error: 'Thiếu hoặc sai X-API-Key header. Cung cấp API key hợp lệ.',
    });
  }
  next();
}

module.exports = { rateLimit, requireApiKey };
