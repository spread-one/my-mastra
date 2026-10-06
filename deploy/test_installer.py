"""Local staged installer/asset fixtures; no live server installation."""
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('cosign_download', ROOT / 'deploy/cosign_download.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class InstallerTests(unittest.TestCase):
    def install(self, stage):
        return subprocess.run(['bash', str(ROOT / 'deploy/install.sh'), '--stage', str(stage)],
                              env={k: v for k, v in os.environ.items() if k != 'APP_DIR'},
                              capture_output=True, text=True, timeout=5)

    def test_upgrade_lock_and_all_state_env_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory).resolve()
            self.assertEqual(self.install(stage).returncode, 0)
            app = stage / 'opt/samkim'
            (app / 'install-backup').rename(app / 'reviewed-first-backup')
            (app / 'compose.yaml').write_text('old reviewed compose')
            (app / '.env').write_text('synthetic-private')
            (app / '.env.runtime').write_text('synthetic-runtime')
            (app / 'image.env').write_text('preserved-digest')
            (app / 'state').mkdir(mode=0o700)
            (app / 'state/deployed.json').write_text('preserved-state')
            before = {p: p.read_bytes() for p in [app / '.env', app / '.env.runtime', app / 'image.env', app / 'state/deployed.json']}
            with open(app / 'deploy.lock', 'w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = self.install(stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('locked_busy', result.stderr)
                self.assertEqual((app / 'compose.yaml').read_text(), 'old reviewed compose')
            result = self.install(stage)
            self.assertEqual(result.returncode, 0, result.stderr)
            for path, data in before.items():
                self.assertEqual(path.read_bytes(), data)
            self.assertIn('mem_limit: 1g', (app / 'compose.yaml').read_text())
            self.assertEqual((app / 'install-backup/1').read_text(), 'old reviewed compose')
            self.assertFalse((app / 'install-pending.json').exists())
            # Staged templates-only is deliberately NOT a verifier installation claim.
            self.assertFalse((app / 'cosign').exists())

    def test_pending_deploy_or_install_blocks_upgrade_without_replacements(self):
        for kind in ['install', 'deploy']:
            with tempfile.TemporaryDirectory() as directory:
                stage = Path(directory).resolve()
                app = stage / 'opt/samkim'
                app.mkdir(parents=True, mode=0o700)
                (app / 'deploy.py').write_text('old code')
                marker = app / 'install-pending.json' if kind == 'install' else app / 'state/pending.json'
                marker.parent.mkdir(exist_ok=True, mode=0o700)
                marker.write_text('pending')
                result = self.install(stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((app / 'deploy.py').read_text(), 'old code')
                self.assertEqual(marker.read_text(), 'pending')

    def test_replacement_error_restores_complete_templates(self):
        source = (ROOT / 'deploy/install.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory).resolve()
            self.assertEqual(self.install(stage).returncode, 0)
            app = stage / 'opt/samkim'
            (app / 'install-backup').rename(app / 'reviewed-first-backup')
            paths = [app / 'deploy.py', app / 'compose.yaml', stage / 'usr/local/sbin/samkim-deploy', stage / 'etc/sudoers.d/samkim-deploy']
            before = {p: (p.read_bytes(), p.stat().st_mode) for p in paths}
            replace = os.replace
            failed = False
            def interrupt(src, dest):
                nonlocal failed
                if dest == app / 'compose.yaml' and not failed:
                    failed = True
                    raise OSError('synthetic disk failure')
                return replace(src, dest)
            with patch.dict(os.environ, {'STAGE': str(stage), 'SOURCE_DIR': str(ROOT / 'deploy')}), patch.object(os, 'replace', side_effect=interrupt), self.assertRaises(OSError):
                exec(compile(source, 'installer-fixture', 'exec'), {})
            self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mode) for p in paths})
            self.assertFalse((app / 'install-pending.json').exists())

    def test_asset_hash_before_execution_and_exact_version(self):
        class Response:
            url = c.URL
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def read(self, _limit): return b'synthetic'
        with patch.object(c.urllib.request, 'urlopen', return_value=Response()), self.assertRaises(ValueError):
            c.fetch_binary()
        with patch.object(c.urllib.request, 'urlopen', return_value=Response()), patch.object(c, 'CHECKSUM', hashlib.sha256(b'synthetic').hexdigest()):
            self.assertEqual(c.fetch_binary(), b'synthetic')
        for version, valid in [('v2.6.5', True), ('v2.4.3', False)]:
            result = subprocess.CompletedProcess([], 0, ('{"gitVersion":"' + version + '"}').encode())
            with patch.object(c.subprocess, 'run', return_value=result) as run:
                if valid:
                    c.check_version(Path('/synthetic/cosign'))
                else:
                    with self.assertRaises(ValueError): c.check_version(Path('/synthetic/cosign'))
                self.assertEqual(run.call_args.kwargs['timeout'], 10)
                self.assertEqual(run.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin'})
