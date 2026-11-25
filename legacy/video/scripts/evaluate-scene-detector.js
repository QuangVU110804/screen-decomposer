'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { getVideoInfo } = require('../src/utils/videoInfo');
const { detectScenes } = require('../src/services/sceneDetectionService');
const { boundaryMetrics } = require('./evaluate-decomposer');

async function main() {
  const root = path.join(__dirname, '..');
  const groundTruth = JSON.parse(
    fs.readFileSync(path.join(root, 'test', 'fixtures', 'decomposer', 'ground-truth.json'), 'utf8')
  );
  const video = groundTruth.videos[0];
  const videoPath = path.join(root, groundTruth.dataset.video);
  if (!fs.existsSync(videoPath)) {
    throw new Error('Missing generated benchmark. Run: npm.cmd run fixtures:decomposer');
  }
  const info = await getVideoInfo(videoPath);
  const detected = await detectScenes('benchmark-scene-detector', videoPath, info, { createPreviews: false });
  const metrics = boundaryMetrics(
    video.scenes,
    detected.scenes,
    groundTruth.thresholds.boundaryToleranceSec
  );
  const result = {
    videoId: video.videoId,
    detectedScenes: detected.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      start: scene.start,
      end: scene.end,
      boundaryOut: scene.boundaryOut,
    })),
    detectorMetrics: detected.metrics,
    boundary: metrics,
    gate: {
      targetF1: groundTruth.thresholds.boundaryF1,
      passed: metrics.f1 >= groundTruth.thresholds.boundaryF1,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.gate.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
