#!/usr/bin/env python3
"""Synthetic host fixtures: no daemon, network, real tokens or remote operations."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('deployment', ROOT / 'deploy/deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
SHA_A, SHA_B, SHA_C = 'a' * 40, 'b' * 40, 'c' * 40
DIGEST_A, DIGEST_B = d.IMAGE + '@sha256:' + '1' * 64, d.IMAGE + '@sha256:' + '2' * 64
ENV = 'DEEPSEEK_API_KEY=synthetic-key\nSLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n'


class Clock:
    def __init__(self):
        self.now = 0

    def sleep(self, seconds):
        self.now += seconds


class Fake(d.Deployer):
    def __init__(self):
        super().__init__()
        self.commands = []
        self.heads = [SHA_B]
        self.sha = SHA_B
        self.labels = {'org.opencontainers.image.source': d.SOURCE, 'org.opencontainers.image.revision': SHA_B}
        self.digests = [DIGEST_B]
        self.platform = ('linux', 'amd64')
        self.running = DIGEST_A
        self.ready = True
        self.restarts = 0
        self.fail_pull = False
        self.fail_network = False
        self.fail_candidate = False
        self.fail_rollback = False
        self.stopped = False

    def run(self, sha=SHA_B, digest=DIGEST_B, force=False, rollback=False):
        return super().run(sha, digest, force, rollback)

    def command(self, args, seconds=20):
        self.commands.append(args)
        if args[1:3] == ['image', 'ls']:
            return ''
        if args[0] == 'git':
            if self.fail_network:
                raise d.Failed('command_failed')
            head = self.heads.pop(0) if len(self.heads) > 1 else self.heads[0]
            return head + '\trefs/heads/main'
        if args[1] == 'pull':
            if self.fail_pull:
                raise d.Failed('command_failed')
            return ''
        if args[1:3] == ['image', 'inspect']:
            ref = args[-1]
            if ref == DIGEST_A:
                return json.dumps({'Config': {'Labels': {**self.labels, 'org.opencontainers.image.revision': SHA_A}}, 'RepoDigests': [DIGEST_A], 'Os': 'linux', 'Architecture': 'amd64'})
            return json.dumps({'Config': {'Labels': self.labels}, 'RepoDigests': self.digests, 'Os': self.platform[0], 'Architecture': self.platform[1]})
        if args[1] == 'compose':
            self.assert_scoped(args)
            if 'up' in args:
                self.running = (d.APP / 'image.env').read_text().strip().split('=', 1)[1]
                self.stopped = False
            elif 'stop' in args:
                self.stopped = True
            elif 'ps' in args:
                return 'f' * 64 if not self.stopped else ''
            return ''
        if args[1] == 'inspect':
            ready = self.ready and not (self.fail_candidate and self.running == DIGEST_B) and not (self.fail_rollback and self.running == DIGEST_A)
            return f'running|{"healthy" if ready else "unhealthy"}|{self.restarts}|{self.running}'
        raise AssertionError('unexpected command')

    @staticmethod
    def assert_scoped(args):
        assert '--project-name' in args and args[args.index('--project-name') + 1] == 'my-mastra'
        assert args[-1] == 'bot'
        assert args[args.index('--project-directory') + 1] == str(d.APP)
        assert args[args.index('--env-file') + 1] == str(d.APP / 'image.env')
        assert args[args.index('-f') + 1] == str(d.APP / 'compose.yaml')
        assert not any(item in args for item in ('down', 'prune', 'rm', 'reset'))
        if 'up' in args:
            assert '--no-deps' in args and '--force-recreate' in args and '--pull' in args


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='deploy-test-')
        self.app = Path(self.temp.name).resolve() / 'opt/samkim'
        self.app.mkdir(parents=True, mode=0o700)
        self.root_patch = patch.object(d, 'APP', self.app)
        self.root_patch.start()
        self.clock = Clock()
        self.time_patch = patch.object(d.time, 'monotonic', lambda: self.clock.now)
        self.sleep_patch = patch.object(d.time, 'sleep', self.clock.sleep)
        self.time_patch.start()
        self.sleep_patch.start()
        d.prepare()
        d.atomic(self.app / '.env', ENV)
        self.fake = Fake()

    def tearDown(self):
        self.sleep_patch.stop()
        self.time_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def existing(self):
        d.atomic(self.app / 'state/env-old', ENV)
        old = {'sha': SHA_A, 'digest': DIGEST_A, 'snapshot': 'env-old'}
        self.fake.save_success(old, None)
        d.atomic(self.app / 'image.env', 'BOT_IMAGE=' + DIGEST_A + '\n')
        d.atomic(self.app / '.env.runtime', ENV)
        return old

    def state(self):
        return json.loads((self.app / 'state/deployed.json').read_text())

    def test_success_digest_pin_private_snapshot_atomic_state_and_same_sha_skip(self):
        old = self.existing()
        self.fake.run()
        self.assertEqual(self.state()['sha'], SHA_B)
        self.assertEqual(self.state()['previous'], old)
        self.assertEqual((self.app / 'image.env').read_text(), 'BOT_IMAGE=' + DIGEST_B + '\n')
        self.assertFalse((self.app / 'state/pending.json').exists())
        self.assertGreaterEqual(self.clock.now, 10)
        self.fake.commands.clear()
        self.fake.run()
        self.assertFalse(any('pull' in cmd or 'up' in cmd for cmd in self.fake.commands))
        for path in [self.app / '.env.runtime', self.app / 'image.env', *self.app.joinpath('state').iterdir()]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_missing_placeholder_invalid_key_and_permissions_preserve_existing(self):
        self.existing()
        for text in ['', ENV.replace('synthetic-key', 'your-deepseek-api-key'), ENV.replace('xapp-synthetic', 'xoxb-private'), ENV + 'OTHER=secret\n', ENV.replace('synthetic-key', 'bad$expansion'), ENV + 'DEEPSEEK_API_KEY=other\n']:
            d.atomic(self.app / '.env', text)
            with self.assertRaises(d.Failed):
                self.fake.run()
            self.assertEqual(self.state()['sha'], SHA_A)
            self.assertEqual(self.fake.running, DIGEST_A)
            self.assertFalse(self.fake.commands)
        d.atomic(self.app / '.env', ENV)
        (self.app / '.env').chmod(0o644)
        with self.assertRaises(d.Failed):
            self.fake.run()

    def test_no_image_and_network_failure_do_not_activate(self):
        self.existing()
        for attribute in ['fail_pull', 'fail_network']:
            setattr(self.fake, attribute, True)
            with self.assertRaises(d.Failed):
                self.fake.run()
            setattr(self.fake, attribute, False)
            self.assertEqual(self.state()['sha'], SHA_A)
            self.assertEqual(self.fake.running, DIGEST_A)
        self.assertFalse(any('up' in command for command in self.fake.commands))

    def test_sha_source_revision_digest_and_platform_are_strict(self):
        self.existing()
        for heads in [['main'], ['a' * 39], ['A' * 40], [SHA_B + ' junk']]:
            self.fake.heads = heads
            with self.assertRaises(d.Failed):
                self.fake.run()
        self.fake.heads = [SHA_B]
        for labels in [{}, {**self.fake.labels, 'org.opencontainers.image.source': 'https://evil.invalid'}, {**self.fake.labels, 'org.opencontainers.image.revision': SHA_A}]:
            previous = self.fake.labels
            self.fake.labels = labels
            with self.assertRaises(d.Failed):
                self.fake.run()
            self.fake.labels = previous
        for digests in [[], [d.IMAGE + '@sha256:abc'], ['other/image@sha256:' + 'a' * 64], [DIGEST_A, DIGEST_A]]:
            self.fake.digests = digests
            with self.assertRaises(d.Failed):
                self.fake.run()
        self.fake.digests = [DIGEST_B]
        self.fake.platform = ('linux', 'arm64')
        with self.assertRaises(d.Failed):
            self.fake.run()
        self.assertEqual(self.fake.running, DIGEST_A)

    def test_stale_head_before_activation_never_replaces(self):
        self.existing()
        self.fake.heads = [SHA_B, SHA_C]
        with self.assertRaisesRegex(d.Failed, 'main_changed'):
            self.fake.run()
        self.assertEqual(self.fake.running, DIGEST_A)
        self.assertFalse((self.app / 'state/pending.json').exists())

    def test_stale_head_before_commit_rolls_back_without_success_state_change(self):
        old = self.existing()
        self.fake.heads = [SHA_B, SHA_B, SHA_C]
        with self.assertRaisesRegex(d.Failed, 'main_changed'):
            self.fake.run()
        self.fake.recover()
        self.assertEqual(self.fake.running, old['digest'])
        self.assertEqual(self.state()['sha'], SHA_A)
        self.assertEqual(json.loads((self.app / 'state/status.json').read_text())['status'], 'rolled_back')

    def test_failed_readiness_restores_digest_and_env_snapshot(self):
        self.existing()
        d.atomic(self.app / '.env', ENV.replace('synthetic-key', 'changed-synthetic'))
        self.fake.fail_candidate = True
        with patch.object(self.fake, 'maintenance') as maintenance:
            with self.assertRaisesRegex(d.Failed, 'readiness_failed'):
                self.fake.run()
            maintenance.assert_not_called()
        self.fake.recover()
        self.assertEqual(self.fake.running, DIGEST_A)
        self.assertEqual((self.app / '.env.runtime').read_text(), d.env_text(self.app / 'state/env-old'))
        self.assertEqual(self.state()['sha'], SHA_A)
        self.assertFalse((self.app / 'state/pending.json').exists())

    def test_restarts_are_not_readiness_and_initial_failure_stops_only_bot(self):
        self.fake.restarts = 1
        with self.assertRaisesRegex(d.Failed, 'readiness_failed'):
            self.fake.run()
        self.fake.recover()
        self.assertFalse((self.app / 'state/deployed.json').exists())
        self.assertTrue(self.fake.stopped)
        self.assertEqual(json.loads((self.app / 'state/status.json').read_text())['status'], 'failed_initial_no_rollback')

    def test_rollback_failure_keeps_pending_and_can_recover_next_poll(self):
        self.existing()
        self.fake.fail_candidate = self.fake.fail_rollback = True
        with self.assertRaises(d.Failed):
            self.fake.run()
        with self.assertRaises(d.Failed):
            self.fake.recover()
        self.assertTrue((self.app / 'state/pending.json').exists())
        self.assertEqual(self.state()['sha'], SHA_A)
        self.fake.fail_rollback = False
        self.fake.recover()
        self.assertFalse((self.app / 'state/pending.json').exists())

    def test_recovery_cannot_overwrite_newer_state_and_completed_commit_wins(self):
        old = self.existing()
        candidate = {'sha': SHA_B, 'digest': DIGEST_B, 'snapshot': 'env-new'}
        d.atomic(self.app / 'state/env-new', ENV)
        d.atomic(self.app / 'state/pending.json', {'candidate': candidate, 'previous': old})
        self.fake.save_success({**candidate, 'sha': SHA_C}, old)
        with self.assertRaisesRegex(d.Failed, 'recovery_state_conflict'):
            self.fake.recover()
        self.assertFalse(any('up' in command for command in self.fake.commands))
        self.fake.save_success(candidate, old)
        self.fake.recover()
        self.assertFalse((self.app / 'state/pending.json').exists())
        self.assertFalse(any('up' in command for command in self.fake.commands))

    def test_force_updates_env_and_manual_rollback_uses_previous_record(self):
        self.existing()
        self.fake.run()
        self.fake.commands.clear()
        self.fake.run(force=True)
        self.assertTrue(any('up' in command for command in self.fake.commands))
        # A fresh successful main deployment has the old known healthy record to restore.
        self.existing()
        self.fake.run()
        self.fake.run(rollback=True)
        self.assertEqual(self.fake.running, DIGEST_A)
        self.assertEqual(self.state()['sha'], SHA_A)

    def test_real_cli_lock_and_safe_root_overrides(self):
        lock = open(self.app / 'deploy.lock', 'w')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(['python3', str(ROOT / 'deploy/deploy.py'), '--sha', SHA_B, '--digest', DIGEST_B], env={**os.environ, 'APP_DIR': str(self.app)}, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn('locked_busy', result.stdout)
        finally:
            lock.close()
        for root in ['/', '/tmp', '/opt', '/opt/other', str(self.app / '..'), 'relative']:
            with patch.object(d, 'APP', Path(root)), self.assertRaises(d.Failed):
                d.prepare()
        symlink = Path(self.temp.name) / 'opt/link'
        symlink.symlink_to(self.app, target_is_directory=True)
        with patch.object(d, 'APP', symlink), self.assertRaises(d.Failed):
            d.prepare()

    def test_fixed_short_root_path_passes_prepare_with_private_state(self):
        # Simulate root-owned /opt/samkim without touching the real /opt filesystem.
        app = Path('/opt/samkim')
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=os.geteuid())
        with patch.object(d, 'APP', app), patch.object(Path, 'resolve', autospec=True, side_effect=lambda path: path), patch.object(Path, 'lstat', return_value=info), patch.object(Path, 'mkdir') as mkdir, patch.object(Path, 'exists', return_value=False), patch.object(Path, 'is_symlink', return_value=False):
            d.prepare()
            mkdir.assert_called_once_with(mode=0o700, exist_ok=True)
        for mode, uid in [(0o755, os.geteuid()), (0o700, os.geteuid() + 1)]:
            bad = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid)
            with patch.object(d, 'APP', app), patch.object(Path, 'resolve', return_value=app), patch.object(Path, 'lstat', return_value=bad), self.assertRaisesRegex(d.Failed, 'app_dir_permissions'):
                d.prepare()
        with patch.object(d, 'APP', app), patch.object(Path, 'resolve', return_value=Path('/elsewhere/samkim')), self.assertRaisesRegex(d.Failed, 'app_dir_unsafe'):
            d.prepare()

    def test_state_directory_stays_private_and_rejects_symlinks(self):
        state = self.app / 'state'
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
        state.chmod(0o750)
        with self.assertRaisesRegex(d.Failed, 'state_dir_permissions'):
            d.prepare()
        state.chmod(0o700)
        state.rmdir()
        elsewhere = Path(self.temp.name).resolve() / 'elsewhere'
        elsewhere.mkdir(mode=0o700)
        state.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(d.Failed, 'state_dir_permissions'):
            d.prepare()
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_entrypoint_failure_status_and_no_secret_logs(self):
        self.existing()
        self.fake.fail_candidate = True
        output = io.StringIO()
        with patch.object(d, 'Deployer', lambda _env: self.fake), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(output):
            self.assertEqual(d.main(), 1)
        self.assertIn('failed_rollback_confirmed', output.getvalue())
        self.assertNotIn('synthetic', output.getvalue())
        self.assertEqual(self.state()['sha'], SHA_A)

    def test_real_cli_with_fake_git_and_docker_binaries(self):
        tools = Path(self.temp.name).resolve() / 'tools'
        tools.mkdir()
        fixture_state = tools / 'fixture.json'
        fixture_state.write_text(json.dumps({'digest': DIGEST_B, 'sha': SHA_B, 'image': '', 'commands': []}))
        binary = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FIXTURE_STATE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
state['commands'].append([Path(sys.argv[0]).name, *args])
if Path(sys.argv[0]).name == 'git':
    print(state['sha'] + '\\trefs/heads/main')
elif args[:2] == ['image', 'inspect']:
    print(json.dumps({'Config': {'Labels': {'org.opencontainers.image.source': 'https://github.com/spread-one/my-mastra', 'org.opencontainers.image.revision': state['sha']}}, 'RepoDigests': [state['digest']], 'Os': 'linux', 'Architecture': 'amd64'}))
elif args[0] == 'compose':
    app = Path(os.environ['APP_DIR'])
    assert args[-1] == 'bot'
    assert args[args.index('--project-directory') + 1] == str(app)
    assert args[args.index('--env-file') + 1] == str(app / 'image.env')
    assert args[args.index('-f') + 1] == str(app / 'compose.yaml')
    if 'up' in args:
        state['image'] = Path(os.environ['APP_DIR'], 'image.env').read_text().strip().split('=', 1)[1]
    elif 'ps' in args:
        print('f' * 64)
elif args[0] == 'inspect':
    print('running|healthy|0|' + state['image'])
path.write_text(json.dumps(state))
'''
        for name in ('git', 'docker'):
            (tools / name).write_text(binary)
            (tools / name).chmod(0o700)
        # Production uses absolute trusted binaries. This test-only loader swaps constants,
        # never adds a production environment/executable override escape hatch.
        runner = tools / 'runner.py'
        runner.write_text('import importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location("fixture_deploy", ' + repr(str(ROOT / 'deploy/deploy.py')) + ')\nd=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(d)\nd.EXECUTABLES={"git": ' + repr(str(tools / 'git')) + ', "docker": ' + repr(str(tools / 'docker')) + '}\nraise SystemExit(d.main())\n')
        env = {**os.environ, 'APP_DIR': str(self.app), 'FIXTURE_STATE': str(fixture_state)}
        result = subprocess.run(['python3', str(runner), '--sha', SHA_B, '--digest', DIGEST_B], env=env, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.state()['digest'], DIGEST_B)
        self.assertNotIn('synthetic', result.stdout + result.stderr)
        for command in json.loads(fixture_state.read_text())['commands']:
            self.assertFalse(any(word in command for word in ('down', 'prune', 'reset', 'config')))
        result = subprocess.run(['python3', str(runner), '--sha', SHA_B, '--digest', DIGEST_B], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn('unchanged_healthy', result.stdout)

    def test_interrupted_initial_config_and_commit_cleanup_failure(self):
        original_atomic = d.atomic
        failed = False
        def interrupt_config(path, value):
            nonlocal failed
            if path == self.app / '.env.runtime' and not failed:
                failed = True
                raise OSError('synthetic private detail')
            original_atomic(path, value)
        with patch.object(d, 'atomic', interrupt_config), patch.object(d, 'Deployer', lambda _env: self.fake), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(d.main(), 1)
        self.assertNotIn('private detail', output.getvalue())
        self.assertIn('failed_initial_no_rollback', output.getvalue())
        self.assertFalse((self.app / 'state/pending.json').exists())
        self.assertTrue(self.fake.stopped)
        self.existing()
        def interrupt_commit(path, value):
            original_atomic(path, value)
            if path.name == 'deployed.json':
                raise OSError('synthetic disk failure after replace')
        with patch.object(d, 'atomic', interrupt_commit), patch.object(d, 'Deployer', lambda _env: self.fake), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(d.main(), 1)
        self.assertEqual(self.state()['sha'], SHA_B)
        self.assertEqual(self.fake.running, DIGEST_B)
        self.assertIn('committed_recovery', output.getvalue())
        self.assertNotIn('rollback_confirmed', output.getvalue())

    def test_anonymous_subprocess_environment_and_bounded_commands(self):
        d.atomic(self.app / '.env', '')
        # Capture production Deployer construction even though preflight blocks the run.
        original = d.Deployer
        captured = []
        def factory(env):
            captured.append(env)
            return original(env)
        with patch.object(d, 'Deployer', factory), patch.dict(os.environ, {'DOCKER_AUTH_CONFIG': 'private', 'BOT_IMAGE': 'evil', 'COMPOSE_FILE': 'evil', 'GIT_SSH_COMMAND': 'evil', 'DEEPSEEK_API_KEY': 'synthetic-private'}), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(d.main(), 1)
        env = captured[0]
        self.assertNotIn('DOCKER_AUTH_CONFIG', env)
        self.assertNotIn('BOT_IMAGE', env)
        self.assertNotIn('COMPOSE_FILE', env)
        self.assertNotIn('GIT_SSH_COMMAND', env)
        self.assertNotIn('DEEPSEEK_API_KEY', env)
        with patch.object(d.subprocess, 'run', side_effect=subprocess.TimeoutExpired('git', 15)) as run:
            with self.assertRaises(d.Failed):
                original().command(['git'], 15)
            self.assertEqual(run.call_args.kwargs['timeout'], 15)


class InstallAndContracts(unittest.TestCase):
    def install(self, stage, override='/opt/samkim'):
        env = {key: value for key, value in os.environ.items() if key != 'APP_DIR'}
        if override is not None:
            env['APP_DIR'] = override
        return subprocess.run(['bash', str(ROOT / 'deploy/install.sh'), '--stage', str(stage)], env=env, capture_output=True, text=True, timeout=5)

    def test_default_app_path_is_fixed_even_in_isolated_python(self):
        code = 'import runpy; print(runpy.run_path(' + repr(str(ROOT / 'deploy/deploy.py')) + ')["APP"])'
        env = {key: value for key, value in os.environ.items() if key != 'APP_DIR'}
        result = subprocess.run(['python3', '-I', '-c', code], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '/opt/samkim')

    def test_fresh_install_allows_only_unset_empty_or_fixed_override(self):
        for override in [None, '', '/opt/samkim']:
            with self.subTest(override=override), tempfile.TemporaryDirectory() as directory:
                stage = Path(directory).resolve()
                result = self.install(stage, override)
                self.assertEqual(result.returncode, 0, result.stderr)
                app = stage / 'opt/samkim'
                self.assertEqual(stat.S_IMODE(app.stat().st_mode), 0o700)
                self.assertEqual(app.stat().st_uid, os.geteuid())
                for name in ['deploy.py', 'compose.yaml']:
                    self.assertEqual((app / name).read_text(), (ROOT / 'deploy' / name).read_text())
                    self.assertEqual(stat.S_IMODE((app / name).stat().st_mode), 0o600)
                wrapper = stage / 'usr/local/sbin/samkim-deploy'
                self.assertEqual(wrapper.read_text(), (ROOT / 'deploy/samkim-deploy').read_text())
                self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o755)
                self.assertEqual(stat.S_IMODE((stage / 'etc/sudoers.d/samkim-deploy').stat().st_mode), 0o440)
                self.assertFalse((stage / 'srv').exists())
                self.assertFalse((app / 'state').exists())
                self.assertFalse((app / '.env').exists())

    def test_staged_install_preserves_secrets_state_and_shared_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory).resolve()
            app = stage / 'opt/samkim'
            app.mkdir(parents=True, mode=0o700)
            (app / '.env').write_text(ENV)
            (app / '.env').chmod(0o600)
            (app / 'state').mkdir(mode=0o700)
            (app / 'state/existing').write_text('keep')
            shared = stage / 'srv/selfhost/apps'
            shared.mkdir(parents=True)
            shared.chmod(0o775)
            (shared / 'other-app').write_text('untouched')
            before = shared.stat()
            result = self.install(stage)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((app / '.env').read_text(), ENV)
            self.assertEqual(stat.S_IMODE((app / '.env').stat().st_mode), 0o600)
            self.assertEqual((app / 'state/existing').read_text(), 'keep')
            self.assertEqual((shared / 'other-app').read_text(), 'untouched')
            self.assertEqual((shared.stat().st_uid, shared.stat().st_mode), (before.st_uid, before.st_mode))
            self.assertFalse((shared / 'my-mastra').exists())
            wrapper = (stage / 'usr/local/sbin/samkim-deploy').read_text()
            self.assertIn('/usr/bin/python3 -I /opt/samkim/deploy.py', wrapper)
            self.assertIn('NOSETENV: /usr/local/sbin/samkim-deploy', (stage / 'etc/sudoers.d/samkim-deploy').read_text())
            self.assertIn('app_not_started', result.stdout)
            self.assertFalse((stage / 'etc/systemd').exists())

    def test_install_custom_and_legacy_app_dir_overrides_rejected_before_writes(self):
        for override in ['/srv/selfhost/apps/my-mastra', '/opt/custom-bot', '/opt/samkim/', '/opt/samkim/../custom', 'relative', '/opt/samkim;id']:
            with self.subTest(override=override), tempfile.TemporaryDirectory() as directory:
                stage = Path(directory).resolve()
                result = self.install(stage, override)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('fixed_path_required', result.stdout)
                self.assertEqual(list(stage.iterdir()), [])

    def test_install_app_permissions_and_symlink_paths_rejected(self):
        for kind in ['permissions', 'parent', 'app', 'file']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                stage = Path(directory).resolve()
                app = stage / 'opt/samkim'
                if kind in ['permissions', 'file']:
                    app.mkdir(parents=True, mode=0o700)
                    if kind == 'permissions':
                        app.chmod(0o755)
                    else:
                        (app / 'deploy.py').symlink_to(app / 'compose.yaml')
                else:
                    elsewhere = stage / 'elsewhere'
                    elsewhere.mkdir(mode=0o700)
                    link = stage / 'opt' if kind == 'parent' else app
                    link.parent.mkdir(parents=True, exist_ok=True)
                    link.symlink_to(elsewhere, target_is_directory=True)
                result = self.install(stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('app_dir_permissions' if kind == 'permissions' else 'symlink_', result.stderr)
                self.assertFalse((stage / 'usr/local/sbin/samkim-deploy').exists())

    def test_production_installer_rejects_untrusted_parents_before_writes(self):
        # Execute the actual installer Python preflight with a synthetic root filesystem.
        # Stage mode intentionally does not assert host root ownership; do not use it
        # as evidence that the production trusted-parent checks ran.
        source = (ROOT / 'deploy/install.sh').read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        for parent in ['/', '/opt', '/opt/samkim', '/usr', '/usr/local', '/usr/local/sbin', '/etc', '/etc/sudoers.d']:
            for uid, mode in [(1000, 0o700), (0, 0o720), (0, 0o702)]:
                with self.subTest(parent=parent, uid=uid, mode=oct(mode)):
                    def info(path):
                        return SimpleNamespace(st_uid=uid if str(path) == parent else 0, st_mode=stat.S_IFDIR | (mode if str(path) == parent else 0o700))
                    with patch.dict(os.environ, {'STAGE': '', 'SOURCE_DIR': str(ROOT / 'deploy')}), patch.object(Path, 'exists', return_value=True), patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'stat', autospec=True, side_effect=info), patch.object(Path, 'mkdir') as mkdir, self.assertRaisesRegex(SystemExit, 'untrusted_parent_path'):
                        exec(compile(source, 'install-fixture', 'exec'), {})
                    mkdir.assert_not_called()
        for parent in ['/opt', '/opt/samkim', '/usr', '/usr/local', '/usr/local/sbin', '/etc', '/etc/sudoers.d']:
            with self.subTest(symlink=parent), patch.dict(os.environ, {'STAGE': '', 'SOURCE_DIR': str(ROOT / 'deploy')}), patch.object(Path, 'exists', return_value=False), patch.object(Path, 'is_symlink', autospec=True, side_effect=lambda path: str(path) == parent), patch.object(Path, 'mkdir') as mkdir, self.assertRaisesRegex(SystemExit, 'symlink_path'):
                exec(compile(source, 'install-fixture', 'exec'), {})
            mkdir.assert_not_called()

    def test_workflow_only_trusted_main_publishes_after_hosted_check(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        check, publish = workflow.split('  publish:\n')
        self.assertIn('pull_request:', check)
        self.assertIn('runs-on: ubuntu-latest', check)
        self.assertIn('    needs: check\n', publish)
        self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'spread-one/my-mastra'", publish)
        self.assertEqual(workflow.count('packages: write'), 1)
        self.assertNotIn('packages: write', check)
        self.assertNotIn('self-hosted', workflow)
        self.assertIn('platforms: linux/amd64', publish)
        self.assertIn('tags: ghcr.io/spread-one/my-mastra:sha-${{ github.sha }}', publish)
        self.assertIn('${{ steps.image.outputs.digest }}', publish)
        self.assertNotIn(':latest', workflow)
        self.assertIn('contents: read', check)
        for secret in ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DEEPSEEK_API_KEY', 'cache-to:', 'pull_request_target']:
            self.assertNotIn(secret, workflow)

    def test_docker_and_compose_contracts(self):
        dockerignore = (ROOT / '.dockerignore').read_text()
        self.assertIn('\n**\n', dockerignore)
        self.assertIn('!src/**', dockerignore)
        self.assertIn('\n.env*\n', dockerignore)
        self.assertIn('\n.git\n', dockerignore)
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertEqual(dockerfile.count('FROM node:24-bookworm-slim'), 3)
        self.assertIn('npm ci --omit=dev', dockerfile)
        self.assertIn('USER node', dockerfile)
        self.assertIn('"/usr/bin/tini", "-s", "--"', dockerfile)
        self.assertIn('"node", "dist/slack.js"', dockerfile)
        self.assertNotIn('COPY .', dockerfile)
        compose = (ROOT / 'deploy/compose.yaml').read_text()
        for value in ['restart: unless-stopped', 'init: true', 'read_only: true', 'cap_drop: [ALL]', 'format: raw', 'max-size:', 'max-file:']:
            self.assertIn(value, compose)
        self.assertNotIn('ports:', compose)
        self.assertNotIn('docker.sock', compose)
        self.assertNotIn('build:', compose)
        self.assertFalse((ROOT / 'deploy/my-mastra-deploy.service').exists())
        self.assertFalse((ROOT / 'deploy/my-mastra-deploy.timer').exists())
        wrapper = (ROOT / 'deploy/samkim-deploy').read_text()
        self.assertIn('exec /usr/bin/env -i', wrapper)
        self.assertIn('/usr/bin/python3 -I /opt/samkim/deploy.py', wrapper)
        self.assertNotIn('self-hosted', (ROOT / '.github/workflows/ci.yml').read_text())


if __name__ == '__main__':
    unittest.main()
