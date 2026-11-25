const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');

const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      config.ensureDir(config.UPLOAD_TMP_DIR);
      cb(null, config.UPLOAD_TMP_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, _file, cb) => {
    const filename = `${randomUUID()}.part`;
    // Multer may not expose req.file when it aborts on LIMIT_FILE_SIZE. Keep
    // the generated path on the request so the route can clean it reliably.
    req._uploadTempPath = path.join(config.UPLOAD_TMP_DIR, filename);
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
});

async function removeTempUpload(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { upload, removeTempUpload };
