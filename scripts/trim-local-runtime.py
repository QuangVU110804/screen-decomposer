"""Slim the pinned Windows CPU wheel for inference-only use."""
import argparse
from importlib.metadata import version
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig


def trim_torch_sdk(torch):
    torch = torch.resolve(strict=True)
    if not (torch / 'lib/torch_cpu.dll').is_file():
        raise RuntimeError('Không tìm thấy thư viện PyTorch CPU trong venv.')
    targets = [*(torch / 'lib').glob('*.lib'), torch / 'include',
               torch / 'share/cmake', torch / 'bin/protoc.exe']
    removed = 0
    for target in targets:
        if not target.resolve().is_relative_to(torch):
            raise RuntimeError(f'Tệp nằm ngoài PyTorch: {target}')
        if target.is_dir():
            removed += sum(p.stat().st_size for p in target.rglob('*') if p.is_file())
            shutil.rmtree(target)
        elif target.is_file():
            removed += target.stat().st_size
            target.unlink()
    return removed


def compact_runtime(venv, models):
    extensions = {'.dll', '.pyd', '.onnx', '.pt'}
    paths = []
    for directory in (venv, models):
        for file in directory.rglob('*'):
            if file.suffix.lower() not in extensions or not file.is_file():
                continue
            if not file.resolve().is_relative_to(directory):
                raise RuntimeError(f'Tệp nằm ngoài thư mục runtime: {file}')
            info = file.stat()
            if info.st_size >= 1024**2 and info.st_nlink == 1:
                paths.append(str(file))
    if paths:
        compact = Path(os.environ['SystemRoot']) / 'System32/compact.exe'
        subprocess.run([str(compact), '/C', '/EXE:LZX', '/Q', *paths], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compact', action='store_true', help='Losslessly compress large runtime binaries and models on NTFS')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    venv = Path(sys.prefix).resolve()
    torch = (Path(sysconfig.get_path('purelib')) / 'torch').resolve()
    if os.name != 'nt' or venv != root / '.venv' or not torch.is_relative_to(venv):
        parser.error('Chạy bằng Python trong venv Windows của dự án.')
    if version('torch') != '2.5.1+cpu':
        parser.error('Chỉ thu gọn bộ cài PyTorch 2.5.1+cpu đã kiểm thử.')
    removed = trim_torch_sdk(torch)
    print(f'PyTorch SDK removed: {removed:,} bytes', flush=True)
    if args.compact:
        models = root / 'models'
        if not models.resolve().is_relative_to(root):
            parser.error('Thư mục model phải nằm trong dự án.')
        compact_runtime(venv, models)


if __name__ == '__main__':
    main()
