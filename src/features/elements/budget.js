'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { directoryBytes } = require('../../shared/files');
const { artifactNames } = require('./cache');
async function discardWorkerFiles(output, elements) {
  const names = artifactNames(elements);
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (entry.isFile() && !names.has(entry.name)) await fs.unlink(path.join(output, entry.name));
  }
}
async function trimOutputToBudget(config, dir, output, result) {
  await discardWorkerFiles(output, result.elements);
  let bytes = await directoryBytes(dir);
  const kept = [...result.elements];
  while (kept.length && bytes > config.maxArtifactBytes) {
    const removed = kept.pop();
    const remaining = artifactNames(kept);
    for (const name of artifactNames([removed])) {
      if (!remaining.has(name)) await fs.unlink(path.join(output, name));
    }
    bytes = await directoryBytes(dir);
  }
  if (bytes > config.maxArtifactBytes) throw new Error('Ảnh nguồn đã vượt ngân sách dung lượng job.');
  result.elements = kept;
  result.warnings = [...(result.warnings || []), 'Đã chạm giới hạn dung lượng. Chỉ giữ các element hợp lệ trong ngân sách.'];
  return result;
}
module.exports = { discardWorkerFiles, trimOutputToBudget };
