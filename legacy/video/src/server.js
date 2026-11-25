require('dotenv').config();
const express = require('express');
const path = require('path');
const extractRoutes = require('./routes/extractRoutes');
const assetRoutes = require('./routes/assetRoutes');
const decomposerRoutes = require('./routes/decomposerRoutes');
const cleanupService = require('./services/cleanupService');
const db = require('./services/db');
const {
  PORT,
  VIDEO_DIR,
  CANDIDATE_DIR,
  ASSET_DIR,
  JOB_DIR,
  UPLOAD_TMP_DIR,
  FFMPEG_PATH,
  FFPROBE_PATH,
  YT_DLP_PATH,
  ANTHROPIC_API_KEY,
  API_KEY,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  ensureDir,
  assertBinaries,
  validateConfig,
} = require('./config');

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] — exiting:', err);
  process.exit(1);
});

try {
  assertBinaries();
} catch (err) {
  console.error('[boot] Binary check failed:', err.message);
  process.exit(1);
}

try {
  validateConfig({ allowMissingApiKey: true });
} catch (err) {
  console.error('[boot] Config validation failed:', err.message);
  process.exit(1);
}

for (const dir of [VIDEO_DIR, CANDIDATE_DIR, ASSET_DIR, JOB_DIR, UPLOAD_TMP_DIR]) {
  ensureDir(dir);
}

// Recover any jobs that were mid-flight before a restart.
const recoveredJobIds = db.markInterruptedJobsFailed();
if (recoveredJobIds.length > 0) {
  console.log(`[boot] Recovered ${recoveredJobIds.length} interrupted job(s) → failed`);
}

cleanupService.startCleanupScheduler();

console.log(
  `[boot] ffmpeg=${FFMPEG_PATH} ffprobe=${FFPROBE_PATH} yt-dlp=${YT_DLP_PATH} ` +
  `apiKey=${ANTHROPIC_API_KEY ? 'set' : 'missing'} ` +
  `auth=${API_KEY ? 'enabled' : 'disabled'} ` +
  `rateLimit=${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS}ms ` +
  `db=${db.DB_PATH}`
);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', extractRoutes);
app.use('/api/v2', decomposerRoutes);
app.use('/', assetRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Video Scene Decomposer chạy tại http://localhost:${PORT}`);
});
