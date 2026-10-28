import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('prepare_k3s_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleaseAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        (self.path / 'source-sha').write_text('a' * 40)
        (self.path / 'run-id').write_text('123')
        for c in release.COMPONENTS:
            (self.path / f'{c}.digest').write_text(f'ghcr.io/supenbysz/kycrm-{c}@sha256:' + 'b' * 64)
    def test_accepts_exact_release(self):
        self.assertEqual(len(release.validate_release(self.path, 'a' * 40, '123')), 7)
    def test_rejects_wrong_source(self):
        with self.assertRaises(ValueError): release.validate_release(self.path, 'c' * 40, '123')
    def test_rejects_wrong_run(self):
        with self.assertRaises(ValueError): release.validate_release(self.path, 'a' * 40, '124')
    def test_rejects_tag_and_foreign_component(self):
        for value in ['ghcr.io/supenbysz/kycrm-web:latest', 'ghcr.io/supenbysz/kycrm-auth@sha256:' + 'b' * 64, 'other.registry/web@sha256:' + 'b' * 64]:
            with self.subTest(value=value):
                (self.path / 'web.digest').write_text(value)
                with self.assertRaises(ValueError): release.validate_release(self.path, 'a' * 40, '123')

if __name__ == '__main__': unittest.main()
