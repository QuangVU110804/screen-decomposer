require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const config = require('../src/config');
const { createJob } = require('../src/services/jobService');
const { findCandidates } = require('../src/services/candidateService');
const { getDuration } = require('../src/utils/videoInfo');
const { hamming } = require('../src/utils/hash');

const videoPath = path.join(config.TEMP_DIR, 'test-fixtures', 'phase2', 'slideshow.mp4');
const expectedTimestamps = [6, 10, 14, 18, 22, 26, 30, 34];

if (!fs.existsSync(videoPath)) {
  console.error('Missing slideshow fixture. Run: node scripts/make-fixtures.js');
  process.exit(1);
}

async function main() {
  const duration = await getDuration(videoPath);
  const rows = [];
  for (const freezeD of [0.8, 3]) {
    for (const phashThreshold of [10, 20]) {
      const jobId = `tune-${Date.now()}-${freezeD}-${phashThreshold}`;
      const job = createJob(jobId, { duration });
      const started = performance.now();
      const candidates = await findCandidates(job, videoPath, null, {
        minStillSec: freezeD,
        phashThreshold,
      });
      const elapsed = Math.round(performance.now() - started);
      const missed = expectedTimestamps.filter((expected) => (
        !candidates.some((candidate) => Math.abs(candidate.timestamp - expected) <= 1.5)
      )).length;
      let dupes = 0;
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          if (hamming(candidates[i].hash, candidates[j].hash) <= phashThreshold / 2) dupes++;
        }
      }
      rows.push({
        video: 'slideshow.mp4',
        fps: config.SAMPLE_FPS,
        freeze_d: freezeD,
        hamming: phashThreshold,
        candidates: candidates.length,
        expected: expectedTimestamps.length,
        missed,
        dupes,
        time_ms: elapsed,
      });
    }
  }
  console.table(rows);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
