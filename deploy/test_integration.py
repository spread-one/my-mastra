"""Offline runtime deployment integration contracts; no production Docker/env access."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('runtime_deploy', ROOT / 'deploy/deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

BASE = 'DEEPSEEK_API_KEY=synthetic\nSLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n'
VISION = 'VISION_API_KEY=synthetic-vision\nVISION_BASE_URL=https://vision-provider.org/v1\nVISION_MODEL=vision-model\n'


class IntegrationContracts(unittest.TestCase):
    def env(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.env'
            path.write_text(text)
            path.chmod(0o600)
            return d.env_text(path)

    def test_exact_optional_vision_allowlist_and_safe_validation(self):
        self.assertIn('VISION_MODEL=vision-model', self.env(BASE + VISION))
        self.assertNotIn('VISION_', self.env(BASE))
        self.assertIn('VISION_MODEL=\n', self.env(BASE + 'VISION_API_KEY=\nVISION_BASE_URL=\nVISION_MODEL=\n'))
        for extra in [
            'VISION_API_KEY=private\n', 'VISION_MODEL=vision\n', 'SLACK_HISTORY_DB=/arbitrary/host\n',
            'VISION_EXTRA=private\n', VISION.replace('https://vision-provider.org/v1', 'http://vision-provider.org/v1'),
            VISION.replace('https://vision-provider.org/v1', 'https://127.0.0.1/v1'),
            VISION.replace('https://vision-provider.org/v1', 'https://internal.local/v1'),
            VISION.replace('https://vision-provider.org/v1', 'https://user:private@vision-provider.org/v1'),
            VISION.replace('https://vision-provider.org/v1', 'https://vision-provider.org/v1?key=private'),
            VISION.replace('VISION_MODEL=vision-model', 'VISION_MODEL=vision model'),
        ]:
            with self.subTest(extra=extra), self.assertRaises(d.Failed) as result:
                self.env(BASE + extra)
            self.assertNotIn('private', str(result.exception))

    def test_private_image_seed_fixed_persistent_volume_and_prior_security_remain(self):
        docker = (ROOT / 'Dockerfile').read_text()
        compose = (ROOT / 'deploy/compose.yaml').read_text()
        self.assertIn('install -d -m 0700 -o 1000 -g 1000 /var/lib/my-mastra /var/lib/my-mastra/history', docker)
        self.assertIn('USER node', docker)
        self.assertIn('"/usr/bin/tini", "-s", "--"', docker)
        for value in ['name: my-mastra-history', '- history:/var/lib/my-mastra',
                      'SLACK_HISTORY_DB: /var/lib/my-mastra/history/history.sqlite',
                      'read_only: true', 'user: "1000:1000"', 'cap_drop: [ALL]',
                      'no-new-privileges:true', 'cpus: 1.0', 'mem_limit: 1g', 'pids_limit: 128']:
            self.assertIn(value, compose)
        self.assertNotIn('/var/lib/my-mastra:rw', compose)  # never tmpfs history
        deploy = (ROOT / 'deploy/deploy.py').read_text()
        installer = (ROOT / 'deploy/install.sh').read_text()
        self.assertNotIn('volume rm', deploy + installer)
        self.assertNotIn('volume prune', deploy + installer)
        smoke = (ROOT / 'deploy/smoke.sh').read_text()
        self.assertIn('stat.uid !== 1000', smoke)
        self.assertIn('pairs[1]?.content !== "canonical fixture"', smoke)
        self.assertIn('name: %s', smoke)  # hosted test uses a unique synthetic volume, never production
