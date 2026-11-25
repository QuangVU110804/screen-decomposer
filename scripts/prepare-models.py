"""Keep a stable detector path, sharing the bundled bytes when possible."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
import rapidocr_onnxruntime

root = Path(__file__).resolve().parents[1]
models = root / 'models'
target = models / 'rapidocr'
if not target.resolve().is_relative_to(root):
    raise RuntimeError('Thư mục model phải nằm trong dự án.')
target.mkdir(parents=True, exist_ok=True)
package = Path(rapidocr_onnxruntime.__file__).resolve().parent
candidates = list((package / 'models').glob('*det*.onnx'))
if len(candidates) != 1:
    raise RuntimeError(f'Expected one bundled text detector, found {len(candidates)}')
source, detector = candidates[0].resolve(), target / 'det.onnx'
expected = 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9'
if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
    raise RuntimeError('SHA-256 của detector RapidOCR 1.4.4 không khớp. Hãy cài lại wheel đã pin.')
if detector.is_symlink() or not detector.exists() or not source.samefile(detector):
    with TemporaryDirectory(dir=target) as tmp:
        staged = Path(tmp) / detector.name
        if sys.prefix != sys.base_prefix and source.is_relative_to(Path(sys.prefix).resolve()):
            try:
                os.link(source, staged)
            except OSError:
                pass
        if not staged.exists():
            shutil.copy2(source, staged)
        staged.replace(detector)
files = []
for name in ['mobile_sam.pt', 'rapidocr/det.onnx']:
    data = (models / name).read_bytes()
    files.append({'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
manifest = {'mobileSamRevision': 'f706ad9c4eb7f219c00d9050e46328518ffb65d2',
            'rapidOcrVersion': importlib.metadata.version('rapidocr-onnxruntime'),
            'ocrOriginalFilename': candidates[0].name, 'files': files}
(models / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps(manifest, indent=2))
