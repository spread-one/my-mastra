import copy
import importlib.util
import io
import contextlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('retention_deployment', ROOT / 'deploy/deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def record(n):
    return {'sha': format(n, 'x') * 40, 'digest': d.IMAGE + '@sha256:' + format(n, 'x') * 64, 'snapshot': 'env-' + str(n)}


def metadata(n):
    item = record(n)
    return {'Id': 'sha256:' + format(n, 'x') * 64, 'Config': {'Labels': {'org.opencontainers.image.source': d.SOURCE, 'org.opencontainers.image.revision': item['sha']}},
            'RepoDigests': [item['digest']], 'RepoTags': [], 'Os': 'linux', 'Architecture': 'amd64'}


class Docker(d.Deployer):
    def __init__(self):
        super().__init__()
        self.images = {metadata(n)['Id']: metadata(n) for n in range(1, 6)}
        self.containers = {}
        self.removed = []
        self.inspect_calls = {}
        self.container_calls = 0
        self.mutate = None
        self.commands = []
        self.fail_rm = False

    def command(self, args, seconds=20):
        self.commands.append(args)
        if args[1:3] == ['image', 'ls']:
            return '\n'.join(self.images)
        if args[1:3] == ['image', 'inspect']:
            image_id = args[-1]
            self.inspect_calls[image_id] = self.inspect_calls.get(image_id, 0) + 1
            if self.mutate:
                self.mutate(self, image_id, self.inspect_calls[image_id])
            return json.dumps(self.images[image_id])
        if args[1] == 'ps':
            self.container_calls += 1
            return '\n'.join(self.containers)
        if args[1] == 'inspect':
            return self.containers[args[-1]]
        if args[1:3] == ['image', 'rm']:
            if self.fail_rm or args[-1] in self.containers.values():
                raise d.Failed('command_failed')
            self.removed.append(args[-1])
            return ''
        raise AssertionError('unexpected Docker command')


class Retention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='retention-')
        app = Path(self.temp.name).resolve() / 'opt/samkim'
        app.mkdir(parents=True, mode=0o700)
        self.app = app
        self.override = patch.object(d, 'APP', app)
        self.override.start()
        (self.app / 'state').mkdir(mode=0o700)
        d.prepare()
        self.docker = Docker()
        for n in range(1, 7):
            d.atomic(app / 'state' / record(n)['snapshot'], 'DEEPSEEK_API_KEY=synthetic\n')
        self.state = {**record(5), 'previous': record(4), 'history': [record(5), record(4), record(3)]}
        d.atomic(app / 'state/deployed.json', self.state)

    def tearDown(self):
        self.override.stop()
        self.temp.cleanup()

    def test_current_rollback_recent_three_protected_only_owned_old_removed(self):
        self.docker.retain_images()
        self.assertEqual(set(self.docker.removed), {metadata(1)['Id'], metadata(2)['Id']})
        self.assertEqual(d.read_json(self.app / 'state/deployed.json'), self.state)
        for args in self.docker.commands:
            self.assertNotIn('--force', args)
            self.assertFalse(set(args) & {'prune', 'builder', 'system', 'down', 'build'})
        self.docker.clean_snapshots()
        self.assertEqual({path.name for path in (self.app / 'state').glob('env-*')}, {'env-3', 'env-4', 'env-5'})

    def test_foreign_alias_provenance_and_all_stopped_container_references_protected(self):
        self.docker.images[metadata(1)['Id']]['RepoTags'] = ['foreign/other:latest']
        self.docker.containers['a' * 64] = metadata(2)['Id']
        self.docker.retain_images()
        self.assertEqual(self.docker.removed, [])
        self.docker.containers.clear()
        self.docker.images[metadata(2)['Id']]['Config']['Labels']['org.opencontainers.image.source'] = 'https://foreign.invalid'
        self.docker.retain_images()
        self.assertEqual(self.docker.removed, [])

    def test_unknown_wrong_platform_digest_foreign_repo_and_id_mismatch_protected(self):
        for patch_info in [{'RepoDigests': []}, {'Architecture': 'arm64'}, {'RepoDigests': ['foreign/image@sha256:' + '1' * 64]}, {'Id': 'sha256:' + 'f' * 64}, {'Config': {'Labels': {}}}]:
            self.docker.images = {metadata(1)['Id']: {**metadata(1), **patch_info}}
            self.docker.retain_images()
            self.assertEqual(self.docker.removed, [])

    def test_state_and_image_mutations_fail_closed(self):
        self.docker.images = {metadata(1)['Id']: metadata(1)}
        def state_race(docker, image_id, count):
            d.atomic(self.app / 'state/deployed.json', {**self.state, 'sha': 'f' * 40})
        self.docker.mutate = state_race
        with self.assertRaisesRegex(d.Failed, 'retention_state_changed'):
            self.docker.retain_images()
        self.assertEqual(self.docker.removed, [])
        d.atomic(self.app / 'state/deployed.json', self.state)
        def image_race(docker, image_id, count):
            if count >= 2:
                docker.images[image_id]['RepoTags'] = ['foreign/new:latest']
        self.docker.inspect_calls.clear()
        self.docker.mutate = image_race
        with self.assertRaisesRegex(d.Failed, 'retention_image_changed'):
            self.docker.retain_images()
        self.assertEqual(self.docker.removed, [])

    def test_container_creation_race_and_rm_failure_deferred_without_success_state_change(self):
        self.docker.images = {metadata(1)['Id']: metadata(1)}
        def new_container(docker, image_id, count):
            if count == 2:
                docker.containers['b' * 64] = image_id
        self.docker.mutate = new_container
        self.docker.retain_images()
        self.assertEqual(self.docker.removed, [])
        self.docker.mutate = None
        self.docker.containers.clear()
        self.docker.fail_rm = True
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.docker.maintenance()
        self.assertIn('retention_deferred', output.getvalue())
        self.assertEqual(d.read_json(self.app / 'state/deployed.json'), self.state)

    def test_success_history_is_bounded_current_previous_always_protected(self):
        previous = None
        for n in range(1, 7):
            self.docker.save_success(record(n), previous)
            previous = record(n)
        state = d.read_json(self.app / 'state/deployed.json')
        self.assertEqual([item['sha'] for item in state['history']], [record(n)['sha'] for n in (6, 5, 4)])
        self.assertEqual(state['previous'], record(5))
        # An explicit operator rollback may protect a fourth record outside the recent three.
        d.atomic(self.app / 'state/deployed.json', {**state, 'previous': record(1)})
        self.docker.retain_images()
        self.assertNotIn(metadata(1)['Id'], self.docker.removed)
        self.assertNotIn(metadata(4)['Id'], self.docker.removed)


if __name__ == '__main__':
    unittest.main()
