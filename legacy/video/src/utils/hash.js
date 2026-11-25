const sharp = require('sharp');

/**
 * Return a 64-bit dHash as a 16-character lowercase hexadecimal string.
 * The forced 9x8 grid intentionally uses fit:'fill' so every source frame is
 * transformed in exactly the same way before adjacent pixels are compared.
 */
async function dhashFromFile(filePath) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * width + x] > data[y * width + x + 1] ? '1' : '0';
    }
  }

  let hash = '';
  for (let i = 0; i < bits.length; i += 4) {
    hash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hash;
}

/**
 * Return a brightness-normalized average RGB signature. dHash intentionally
 * operates on grayscale, so this small secondary signal prevents flat red,
 * green and blue slides from collapsing into the same all-zero dHash.
 */
async function chromaFromFile(filePath) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .removeAlpha()
    .resize(1, 1, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const red = data[0] || 0;
  const green = data[Math.min(1, channels - 1)] || 0;
  const blue = data[Math.min(2, channels - 1)] || 0;
  const total = red + green + blue;
  if (total === 0) return [0, 0, 0];
  return [red / total, green / total, blue / total];
}

function chromaDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 3 || b.length !== 3) {
    throw new Error('chromaDistance: expected two RGB signatures');
  }
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Hamming distance between two equal-length hexadecimal hashes. */
function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    throw new Error(`hamming: hash length mismatch (${a?.length} vs ${b?.length})`);
  }
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) {
    throw new Error('hamming: hashes must contain hexadecimal characters only');
  }

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let nibble = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (nibble) {
      distance += nibble & 1;
      nibble >>>= 1;
    }
  }
  return distance;
}

module.exports = { dhashFromFile, hamming, chromaFromFile, chromaDistance };
