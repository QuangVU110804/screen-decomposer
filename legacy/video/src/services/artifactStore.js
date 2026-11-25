'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

function assertId(value, label) {
  const id = String(value || '');
  if (!ID_RE.test(id)) throw new Error(`${label} không hợp lệ`);
  return id;
}

function jobDir(jobId) {
  return path.join(config.JOB_DIR, assertId(jobId, 'jobId'));
}

function sourceDir(jobId) { return path.join(jobDir(jobId), 'source'); }
function sceneDir(jobId, sceneId) { return path.join(jobDir(jobId), 'scenes', assertId(sceneId, 'sceneId')); }
function keyframeDir(jobId, sceneId) { return path.join(sceneDir(jobId, sceneId), 'keyframes'); }
function maskDir(jobId, sceneId) { return path.join(sceneDir(jobId, sceneId), 'masks'); }
function assetDir(jobId, sceneId) { return path.join(sceneDir(jobId, sceneId), 'assets'); }
function cacheDir(jobId, sceneId) { return path.join(sceneDir(jobId, sceneId), 'cache'); }
function manifestPath(jobId) { return path.join(jobDir(jobId), 'manifest.json'); }

async function initialize(jobId) {
  const root = jobDir(jobId);
  await fs.promises.mkdir(sourceDir(jobId), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'scenes'), { recursive: true });
  return root;
}

async function initializeScene(jobId, sceneId) {
  await Promise.all([
    fs.promises.mkdir(keyframeDir(jobId, sceneId), { recursive: true }),
    fs.promises.mkdir(maskDir(jobId, sceneId), { recursive: true }),
    fs.promises.mkdir(assetDir(jobId, sceneId), { recursive: true }),
    fs.promises.mkdir(cacheDir(jobId, sceneId), { recursive: true }),
  ]);
  return sceneDir(jobId, sceneId);
}

async function moveFile(source, destination) {
  try {
    await fs.promises.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(source, destination);
    await fs.promises.unlink(source);
  }
}

async function adoptSource(jobId, inputPath) {
  await initialize(jobId);
  const extension = path.extname(String(inputPath || '')).toLowerCase() || '.video';
  const destination = path.join(sourceDir(jobId), `source${extension}`);
  if (path.resolve(inputPath) !== path.resolve(destination)) {
    await fs.promises.rm(destination, { force: true });
    await moveFile(inputPath, destination);
  }
  return destination;
}

async function writeJsonAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.promises.rename(temporary, filePath);
  return filePath;
}

function assertContained(jobId, filePath) {
  const root = path.resolve(jobDir(jobId));
  const resolved = path.resolve(String(filePath || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Artifact path nằm ngoài job root');
  return resolved;
}

async function removeJobArtifacts(jobId) {
  await fs.promises.rm(jobDir(jobId), { recursive: true, force: true });
}

module.exports = {
  ID_RE,
  jobDir,
  sourceDir,
  sceneDir,
  keyframeDir,
  maskDir,
  assetDir,
  cacheDir,
  manifestPath,
  initialize,
  initializeScene,
  adoptSource,
  writeJsonAtomic,
  assertContained,
  removeJobArtifacts,
};
