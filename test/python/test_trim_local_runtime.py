import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

script = Path(__file__).resolve().parents[2] / 'scripts/trim-local-runtime.py'
spec = importlib.util.spec_from_file_location('trim_local_runtime', script)


class RuntimeTrimTests(unittest.TestCase):
    def test_removes_only_the_torch_build_sdk_and_is_repeatable(self):
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with TemporaryDirectory() as tmp:
            torch = Path(tmp) / 'torch'
            build_files = ['lib/dnnl.lib', 'include/torch/torch.h', 'share/cmake/TorchConfig.cmake', 'bin/protoc.exe']
            runtime_files = ['lib/torch_cpu.dll', 'lib/torch_python.dll', 'bin/fbgemm.dll', 'nn/__init__.py']
            for name in build_files + runtime_files:
                target = torch / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'data')
            self.assertEqual(module.trim_torch_sdk(torch), 16)
            self.assertEqual(module.trim_torch_sdk(torch), 0)
            self.assertTrue(all(not (torch / name).exists() for name in build_files))
            self.assertTrue(all((torch / name).read_bytes() == b'data' for name in runtime_files))
