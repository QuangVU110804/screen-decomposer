const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('dotenv').config();
const config = require('../src/config');
const ingestion = require('../src/services/ingestionService');

test('resolveYoutube accepts the four documented input shapes', () => {
  assert.equal(
    ingestion.resolveYoutube('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(
    ingestion.resolveYoutube('https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(
    ingestion.resolveYoutube('https://youtu.be/dQw4w9WgXcQ?t=3'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(
    ingestion.resolveYoutube('  dQw4w9WgXcQ  '),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
});

test('resolveYoutube rejects non-YouTube URLs instead of handing arbitrary hosts to yt-dlp', () => {
  assert.throws(
    () => ingestion.resolveYoutube('https://example.com/private-video'),
    /Chỉ chấp nhận URL thuộc YouTube/
  );
  assert.throws(
    () => ingestion.resolveYoutube('file:///C:/secret.mp4'),
    /URL YouTube không hợp lệ/
  );
});

test('acceptUpload validates extension and removes a rejected temp file', async () => {
  config.ensureDir(config.UPLOAD_TMP_DIR);
  const source = path.join(config.UPLOAD_TMP_DIR, 'phase1-bad.part');
  await fs.promises.writeFile(source, 'not a video');

  await assert.rejects(
    ingestion.acceptUpload('phase1-bad-extension', {
      path: source,
      originalname: 'notes.txt',
      size: 12,
    }),
    /Định dạng không được hỗ trợ/
  );
  assert.equal(fs.existsSync(source), false);
});

test('acceptUpload moves a valid local video and obtains duration from ffprobe', async (t) => {
  const fixture = path.join(config.TEMP_DIR, 'test-fixtures', 'sample.mp4');
  if (!fs.existsSync(fixture)) {
    t.skip('sample.mp4 fixture is not available');
    return;
  }

  config.ensureDir(config.UPLOAD_TMP_DIR);
  const source = path.join(config.UPLOAD_TMP_DIR, 'phase1-valid.part');
  const jobId = `phase1-valid-${Date.now()}`;
  await fs.promises.copyFile(fixture, source);

  try {
    const result = await ingestion.acceptUpload(jobId, {
      path: source,
      originalname: 'sample.MP4',
      size: (await fs.promises.stat(source)).size,
    });
    assert.equal(path.basename(result.videoPath), `${jobId}.mp4`);
    assert.ok(result.duration > 0);
    assert.equal(result.originalFilename, 'sample.MP4');
  } finally {
    await fs.promises.unlink(path.join(config.VIDEO_DIR, `${jobId}.mp4`)).catch(() => {});
    await fs.promises.unlink(source).catch(() => {});
  }
});
