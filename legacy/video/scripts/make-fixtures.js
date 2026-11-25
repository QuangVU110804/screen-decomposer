require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FFMPEG_PATH, TEMP_DIR } = require('../src/config');

const fixtureDir = path.join(TEMP_DIR, 'test-fixtures', 'phase2');
const fixtureRoot = path.join(TEMP_DIR, 'test-fixtures');

function run(args) {
  const result = spawnSync(FFMPEG_PATH, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with code ${result.status}`);
}

function output(name) {
  return path.join(fixtureDir, name);
}

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(fixtureRoot, { recursive: true });

// Shared five-second continuous-motion fixture used by ingestion, sampling,
// upload cleanup and legacy hardening tests. Generating it here prevents a
// clean CI checkout from silently skipping those cases.
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=25:d=5',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  path.join(fixtureRoot, 'sample.mp4'),
]);

run(['-y', '-f', 'lavfi', '-i', 'smptebars=s=640x480:d=1', '-frames:v', '1', output('bars.png')]);
run(['-y', '-i', output('bars.png'), '-vf', 'eq=brightness=0.1:saturation=1.1', '-frames:v', '1', output('bars_bright.png')]);
run(['-y', '-i', output('bars.png'), '-vf', 'scale=320:240,scale=640:480', '-frames:v', '1', output('bars_resized.png')]);
run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x480', '-frames:v', '1', output('red.png')]);
run(['-y', '-f', 'lavfi', '-i', 'testsrc=s=640x480', '-frames:v', '1', output('testsrc.png')]);
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:d=1', '-frames:v', '1', output('sharp_a.png')]);
run(['-y', '-i', output('sharp_a.png'), '-vf', 'gblur=sigma=4', '-frames:v', '1', output('blur_a.png')]);
run(['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480', '-frames:v', '1', output('flat.png')]);

const clips = [];
for (const [index, color] of ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'orange', 'gray'].entries()) {
  const filename = `slide_${index + 1}.mp4`;
  clips.push(filename);
  run([
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x480:r=25:d=4`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output(filename),
  ]);
}
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=25:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output('intro.mp4'),
]);
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x480:r=25:d=5',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output('outro.mp4'),
]);

const concatList = [
  "file 'intro.mp4'",
  ...clips.map((filename) => `file '${filename}'`),
  "file 'outro.mp4'",
].join('\n') + '\n';
fs.writeFileSync(output('concat.txt'), concatList, 'utf8');
run([
  '-y', '-f', 'concat', '-safe', '0', '-i', output('concat.txt'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output('slideshow.mp4'),
]);

run([
  '-y', '-loop', '1', '-i', output('bars.png'),
  '-vf', "zoompan=z='min(zoom+0.0015,1.2)':d=125:s=640x480:fps=25",
  '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output('kenburns.mp4'),
]);

console.log(`Phase 2 fixtures written to ${fixtureDir}`);
