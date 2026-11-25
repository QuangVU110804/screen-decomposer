'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, directoryBytes, linkImmutable } = require('../../shared/files');

const artifactNames = elements => new Set(elements.flatMap(e => [e.file, e.thumbnail, e.mask, e.sourceFile].filter(Boolean)));
const pendingWrites = new Set();

async function linkArtifacts(elements, source, destination) {
  for (const name of artifactNames(elements)) await linkImmutable(path.join(source, name), path.join(destination, name));
}

async function writeCache(config, cache, id, result, output) {
  const staging = cache + '.' + id;
  pendingWrites.add(staging);
  try {
    await fs.mkdir(staging, { recursive: true });
    await linkArtifacts(result.elements, output, staging);
    await atomicJson(path.join(staging, 'result.json'), result);
    await fs.rm(cache, { recursive: true, force: true });
    await fs.rename(staging, cache);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    pendingWrites.delete(staging);
  }
  await pruneCache(config);
}

async function pruneCache(config) {
  const root = path.join(config.dataDir, 'cache');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const now = Date.now(), live = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}(\.[0-9a-f-]{36})?$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const { mtimeMs } = await fs.stat(dir);
      if (entry.name.length !== 64) {
        if (!pendingWrites.has(dir)) await fs.rm(dir, { recursive: true, force: true });
      } else if (now - mtimeMs > config.retentionMs) await fs.rm(dir, { recursive: true, force: true });
      else live.push({ dir, mtimeMs, bytes: await directoryBytes(dir) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let total = live.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of live.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= config.maxCacheBytes) break;
    await fs.rm(entry.dir, { recursive: true, force: true });
    total -= entry.bytes;
  }
}
module.exports = { artifactNames, linkArtifacts, pruneCache, writeCache };
