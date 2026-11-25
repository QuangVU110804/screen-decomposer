'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const config = require('../src/config');
for (const dir of [config.VIDEO_DIR, config.CANDIDATE_DIR, config.ASSET_DIR, config.JOB_DIR, config.UPLOAD_TMP_DIR]) config.ensureDir(dir);
const testDir = path.join(root, 'test');
const files = fs.readdirSync(testDir)
  .filter((file) => file.endsWith('.test.js'))
  .sort();

let totalTests = 0;
for (const file of files) {
  console.log(`Running ${file}`);
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(testDir, file)],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error.stack || result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);

  const summaries = [
    ...String(result.stdout || '').matchAll(/(?:ℹ|#)\s*tests\s+(\d+)/g),
  ];
  if (summaries.length === 0) {
    console.error(`Could not read the test count from ${file}`);
    process.exit(1);
  }
  totalTests += Number(summaries[summaries.length - 1][1]);
}

console.log(`Serial suite passed: ${totalTests}/${totalTests} tests across ${files.length} files.`);
