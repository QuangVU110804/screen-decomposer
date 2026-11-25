'use strict';
const fs = require('node:fs/promises');
const { COPYFILE_EXCL } = require('node:fs').constants;
const path = require('node:path');
const crypto = require('node:crypto');
function scopedPath(root, relative) {
  const base = path.resolve(root);
  const result = path.resolve(base, relative);
  if (result !== base && !result.startsWith(base + path.sep)) throw new Error('Invalid path: đường dẫn nằm ngoài job');
  return result;
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}
async function directoryBytes(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(p);
    else if (entry.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}
async function linkImmutable(source, destination) {
  try { await fs.link(source, destination); }
  catch (error) {
    if (!['EXDEV','EPERM','EACCES','ENOSYS','ENOTSUP','EOPNOTSUPP','EMLINK'].includes(error.code)) throw error;
    await fs.copyFile(source, destination, COPYFILE_EXCL);
  }
}
module.exports = { scopedPath, atomicJson, directoryBytes, linkImmutable };
