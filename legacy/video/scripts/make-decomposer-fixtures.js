'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const config = require('../src/config');

const root = path.join(config.TEMP_DIR, 'test-fixtures', 'decomposer');
const groundTruth = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'decomposer', 'ground-truth.json'), 'utf8')
);

function run(args) {
  const result = spawnSync(config.FFMPEG_PATH, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with code ${result.status}`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function labeledCard(filePath, title, subtitle, accent = '#7c9cff') {
  const svg = `
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="360" fill="#101827"/>
      <rect x="34" y="34" width="572" height="292" rx="24" fill="#17243a" stroke="${accent}" stroke-width="4"/>
      <text x="320" y="164" text-anchor="middle" fill="#f4f7fb" font-family="Arial" font-size="34" font-weight="700">${escapeXml(title)}</text>
      <text x="320" y="212" text-anchor="middle" fill="#aab7ca" font-family="Arial" font-size="20">${escapeXml(subtitle)}</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function makeCoverageCards() {
  for (let index = 0; index < groundTruth.coverage.length; index++) {
    const item = groundTruth.coverage[index];
    const name = item.type || item.kind;
    const prefix = `${String(index + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9_-]/gi, '-')}`;
    await labeledCard(
      path.join(root, `${prefix}-positive.png`),
      `${name} positive`,
      item.positive,
      '#67d5a5'
    );
    await labeledCard(
      path.join(root, `${prefix}-hard-negative.png`),
      `${name} hard negative`,
      item.hardNegative,
      '#f59e8b'
    );
  }
}

async function makeSceneImages() {
  const scene1 = `
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="360" fill="#21466c"/>
      <circle cx="145" cy="120" r="55" fill="#e3a077"/>
      <rect x="92" y="165" width="106" height="170" rx="42" fill="#d94352"/>
      <rect x="56" y="282" width="300" height="52" rx="10" fill="#101827" opacity=".92"/>
      <text x="76" y="316" fill="white" font-family="Arial" font-size="24" font-weight="700">SYNTHETIC PRESENTER</text>
      <rect x="550" y="18" width="64" height="36" rx="8" fill="#f4d35e"/>
      <text x="582" y="42" text-anchor="middle" fill="#28223a" font-family="Arial" font-size="13" font-weight="700">LOGO</text>
    </svg>`;
  const scene2 = `
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="360" fill="#192337"/>
      <rect x="76" y="42" width="488" height="276" rx="12" fill="#f5f7fb"/>
      <rect x="76" y="42" width="488" height="34" rx="12" fill="#ccd4df"/>
      <rect x="108" y="108" width="280" height="24" fill="#7798d8"/>
      <rect x="108" y="150" width="390" height="14" fill="#bec8d6"/>
      <rect x="108" y="180" width="350" height="14" fill="#bec8d6"/>
      <path d="M470 230 L548 230 L548 208 L590 250 L548 292 L548 270 L470 270 Z" fill="#f25353"/>
    </svg>`;
  const scene3 = `
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="360" fill="#2d1d4b"/>
      <rect x="52" y="62" width="240" height="248" rx="8" fill="#f2d265"/>
      <text x="172" y="185" text-anchor="middle" fill="#28223a" font-family="Arial" font-size="30" font-weight="700">POSTER</text>
      <circle cx="475" cy="104" r="54" fill="#f1b9a5"/>
      <path d="M408 154 Q475 120 542 154 L570 338 L380 338 Z" fill="#4f8cdc" stroke="#a9d5ff" stroke-width="8"/>
      <rect x="550" y="18" width="64" height="36" rx="8" fill="#f4d35e"/>
      <text x="582" y="42" text-anchor="middle" fill="#28223a" font-family="Arial" font-size="13" font-weight="700">LOGO</text>
    </svg>`;
  const values = [scene1, scene2, scene3];
  for (let index = 0; index < values.length; index++) {
    await sharp(Buffer.from(values[index])).png().toFile(path.join(root, `scene_${index + 1}.png`));
  }
}

function makeVideo() {
  const clips = [];
  for (let index = 1; index <= 3; index++) {
    const clip = path.join(root, `scene_${index}.mp4`);
    clips.push(clip);
    run([
      '-y', '-loop', '1', '-i', path.join(root, `scene_${index}.png`),
      '-t', '4', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
    ]);
  }
  const concatPath = path.join(root, 'concat.txt');
  fs.writeFileSync(concatPath, clips.map((clip) => `file '${path.basename(clip)}'`).join('\n') + '\n', 'utf8');
  run([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(root, 'synthetic_decomposer_001.mp4'),
  ]);
}

async function main() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  await makeCoverageCards();
  await makeSceneImages();
  makeVideo();
  console.log(`Decomposer fixtures written to ${root}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
