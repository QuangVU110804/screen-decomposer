'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
async function normalizeImage(input, dir, config, {preview = true} = {}) {
  if (input.length > config.maxBytes) throw Object.assign(new Error('Ảnh vượt giới hạn 20 MB.'), { status: 413 });
  // libvips may expose APNG as one page: inspect structural PNG chunks, not arbitrary byte strings.
  if (input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    for (let offset = 8; offset + 12 <= input.length;) {
      const length = input.readUInt32BE(offset), type = input.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw Object.assign(new Error('Chỉ hỗ trợ ảnh tĩnh; PNG animation chưa được hỗ trợ.'), { status: 400 });
      if (length > input.length - offset - 12 || type === 'IEND') break;
      offset += length + 12;
    }
  }
  let metadata;
  try { metadata = await sharp(input, { limitInputPixels: config.maxPixels, animated: true }).metadata(); }
  catch { throw Object.assign(new Error('Không đọc được ảnh hoặc ảnh vượt giới hạn pixel.'), { status: 400 }); }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw Object.assign(new Error('Chỉ hỗ trợ ảnh JPG, PNG và WebP.'), { status: 400 });
  if ((metadata.pages || 1) !== 1) throw Object.assign(new Error('Chỉ hỗ trợ ảnh tĩnh một trang.'), { status: 400 });
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > config.maxPixels) throw Object.assign(new Error('Ảnh vượt giới hạn kích thước pixel.'), { status: 413 });
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, 'source.png');
  const normalized = await sharp(input, { limitInputPixels: config.maxPixels }).rotate().toColourspace('srgb').ensureAlpha().png({ adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
  await fs.writeFile(source, normalized.data);
  if (preview) await sharp(normalized.data).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toFile(path.join(dir, 'preview.webp'));
  return { source, width: normalized.info.width, height: normalized.info.height, hash: crypto.createHash('sha256').update(normalized.data).digest('hex') };
}
module.exports = { normalizeImage };
