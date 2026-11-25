const sharp = require('sharp');

const WORK_SIZE = 480;

/** Variance of a 3x3 Laplacian on a resolution-normalized grayscale image. */
async function sharpnessFromFile(filePath) {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .grayscale()
    .resize({ width: WORK_SIZE, height: WORK_SIZE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const kernel = [0, 1, 0, 1, -4, 1, 0, 1, 0];
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let response = 0;
      let kernelIndex = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          response += data[(y + ky) * width + (x + kx)] * kernel[kernelIndex];
          kernelIndex++;
        }
      }
      sum += response;
      sumSquares += response * response;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

module.exports = { WORK_SIZE, sharpnessFromFile };
