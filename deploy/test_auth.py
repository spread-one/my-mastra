import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SHA = 'b' * 40
DIGEST = 'ghcr.io/spread-one/my-mastra@sha256:' + '2' * 64


class AuthBoundary(unittest.TestCase):
    def test_wrapper_rejects_argv_flags_paths_shell_and_digest_injection(self):
        wrapper = ROOT / 'deploy/samkim-deploy'
        for args in [[], [SHA], [SHA, DIGEST, '--force'], ['--rollback', DIGEST], [SHA.upper(), DIGEST], ['$(id)', DIGEST], [SHA, 'foreign/image@sha256:' + '2' * 64], [SHA, DIGEST + ';id'], [SHA, DIGEST + '\n'], ['/tmp/evil', DIGEST]]:
            result = subprocess.run(['/bin/sh', str(wrapper), *args], capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertIn('wrapper_invalid', result.stdout)

    def test_validated_wrapper_preserves_only_fixed_args_and_cleans_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            recorder = root / 'recorder'
            recorder.write_text('#!/usr/bin/env python3\nimport json, os, sys\nprint(json.dumps({"args": sys.argv[1:], "env": dict(os.environ)}))\n')
            recorder.chmod(0o700)
            source = (ROOT / 'deploy/samkim-deploy').read_text()
            fixed = '/usr/bin/timeout --signal=TERM --kill-after=110s 240s \\\n  /usr/bin/python3 -I /srv/selfhost/apps/my-mastra/deploy.py'
            self.assertIn(fixed, source)
            # Only the final fixed executable is mocked; original validator/env -i still executes.
            source = source.replace(fixed, str(recorder))
            staged = root / 'wrapper'
            staged.write_text(source)
            result = subprocess.run(['/bin/sh', str(staged), SHA, DIGEST], env={'PATH': '/malicious', 'APP_DIR': '/malicious', 'PYTHONPATH': '/malicious', 'DOCKER_HOST': 'tcp://evil', 'COMPOSE_FILE': '/malicious', 'GIT_SSH_COMMAND': 'evil', 'ENV': '/malicious', 'BASH_ENV': '/malicious'}, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data['args'], ['--sha', SHA, '--digest', DIGEST])
            for key in ['APP_DIR', 'PYTHONPATH', 'DOCKER_HOST', 'COMPOSE_FILE', 'GIT_SSH_COMMAND', 'ENV', 'BASH_ENV']:
                self.assertNotIn(key, data['env'])
            self.assertEqual(data['env']['PATH'], '/usr/bin:/bin')

    def test_ci_auth_failfast_and_native_ssh_exit_status_no_key_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            capture = root / 'capture'
            timeout = root / 'timeout'
            timeout.write_text('#!/usr/bin/env python3\nimport os, sys\nargs=sys.argv[4:]\nos.execvp(args[0], args)\n')
            timeout.chmod(0o700)
            tailscale = root / 'tailscale'
            tailscale.write_text('#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\nPath(os.environ["CAPTURE"]).write_text(json.dumps({"args":sys.argv[1:], "env":dict(os.environ)}))\nsys.exit(int(os.environ.get("RESULT", "0")))\n')
            tailscale.chmod(0o700)
            env = {'PATH': str(root) + ':' + os.environ['PATH'], 'CAPTURE': str(capture), 'DEPLOY_HOST': 'fixture-host.example.ts.net', 'DEPLOY_USER': 'samkim-deploy', 'TS_CI_TAG': 'tag:samkim-ci', 'TS_SERVER_TAG': 'tag:samkim-server', 'TS_OAUTH_CLIENT_ID': 'synthetic-client', 'TS_OAUTH_SECRET': 'synthetic-secret', 'SHA': SHA, 'DIGEST': DIGEST}
            for patch in [{'TS_OAUTH_SECRET': ''}, {'TS_CI_TAG': 'tag:admin'}, {'TS_SERVER_TAG': ''}, {'DEPLOY_USER': 'root'}, {'DEPLOY_HOST': 'host;id'}, {'DEPLOY_HOST': '-oProxyCommand=evil'}, {'SHA': 'main'}, {'DIGEST': DIGEST + '$(id)'}]:
                result = subprocess.run(['bash', str(ROOT / 'deploy/ci-deploy.sh'), '--check'], env={**env, **patch}, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn('synthetic-secret', result.stdout + result.stderr)
                self.assertFalse(capture.exists())
            for status in [0, 1, 124]:
                result = subprocess.run(['bash', str(ROOT / 'deploy/ci-deploy.sh')], env={**env, 'RESULT': str(status)}, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, status, result.stdout + result.stderr)
                data = json.loads(capture.read_text())
                self.assertEqual(data['args'], ['ssh', 'samkim-deploy@fixture-host.example.ts.net', '/usr/bin/sudo', '-n', '/usr/local/sbin/samkim-deploy', SHA, DIGEST])
                self.assertNotIn('TS_OAUTH_SECRET', data['env'])
                self.assertNotIn('TS_OAUTH_CLIENT_ID', data['env'])
                self.assertNotIn('synthetic-secret', result.stdout + result.stderr)

    def test_workflow_trust_privileges_native_auth_and_fixed_sudo_contract(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        check, jobs = workflow.split('  publish:\n')
        publish, deploy = jobs.split('  deploy:\n')
        self.assertNotIn('TS_OAUTH_SECRET', check)
        self.assertNotIn('TS_OAUTH_SECRET', publish)
        self.assertIn('needs: [check, publish]', deploy)
        self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'spread-one/my-mastra'", deploy)
        self.assertIn('runs-on: ubuntu-latest', deploy)
        self.assertIn('contents: read', deploy)
        self.assertNotIn('packages: write', deploy)
        self.assertIn('tags: ${{ vars.TS_CI_TAG }}', deploy)
        self.assertIn('tailscale/github-action@6cae46e2d796f265265cfcf628b72a32b4d7cade', deploy)
        self.assertLess(deploy.index('deploy/ci-deploy.sh --check'), deploy.index('uses: tailscale/'))
        self.assertIn('if: always()', deploy)
        self.assertNotIn('continue-on-error', deploy)
        sudoers = (ROOT / 'deploy/samkim-deploy.sudoers').read_text()
        self.assertIn('NOSETENV: /usr/local/sbin/samkim-deploy', sudoers)
        self.assertNotIn('NOPASSWD: ALL', sudoers)
        self.assertNotIn('/usr/bin/docker', sudoers)
        script = '\n'.join(line for line in (ROOT / 'deploy/ci-deploy.sh').read_text().splitlines() if not line.lstrip().startswith('#'))
        for forbidden in ['StrictHostKeyChecking=no', 'ssh -i ', 'scp ', 'docker build', 'compose build']:
            self.assertNotIn(forbidden, script)


if __name__ == '__main__':
    unittest.main()
