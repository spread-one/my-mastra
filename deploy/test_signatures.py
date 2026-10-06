"""Synthetic verifier responses only: NOT real OIDC/certificate/registry E2E."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_deploy as fixtures
from test_deploy import DIGEST_A, DIGEST_B, SHA_B, d


class SignatureTests(unittest.TestCase):
    existing = fixtures.DeployTests.existing
    state = fixtures.DeployTests.state
    tearDown = fixtures.DeployTests.tearDown
    def setUp(self):
        fixtures.DeployTests.setUp(self)
        self.binary = self.app / 'cosign'
        self.binary.write_bytes(b'synthetic executable')
        self.binary.chmod(0o700)
        self.original_lstat = Path.lstat
        self.uid = 0
        self.mode = stat.S_IFREG | 0o700
        self.version = d.COSIGN_VERSION
        self.reject = set()
        self.certificate_identity = d.IDENTITY
        self.certificate_issuer = d.ISSUER
        self.payload_digest = None
        self.payload_repo = d.IMAGE
        self.error = None
        self.calls = []

    def trusted_stat(self, path):
        if path == self.binary:
            return SimpleNamespace(st_uid=self.uid, st_mode=self.mode)
        if path in self.binary.parents:
            return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)
        return self.original_lstat(path)

    def cosign(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        if args[1] == 'version':
            return SimpleNamespace(returncode=0, stdout=json.dumps({'gitVersion': self.version}))
        self.assertEqual(args[1:7], ['verify', '--certificate-identity', d.IDENTITY,
                                    '--certificate-oidc-issuer', d.ISSUER, '--output'])
        self.assertEqual(args[7], 'json')
        if (args[-1] in self.reject or args[3] != self.certificate_identity
                or args[5] != self.certificate_issuer):
            return SimpleNamespace(returncode=1, stdout='synthetic-private-error')
        return SimpleNamespace(returncode=0, stdout=json.dumps([{'critical': {
            'type': 'cosign container image signature',
            'identity': {'docker-reference': self.payload_repo},
            'image': {'docker-manifest-digest': self.payload_digest or args[-1].split('@')[1]}}}]))

    def verification(self):
        import contextlib
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(d, 'COSIGN', self.binary))
        stack.enter_context(patch.object(d, 'COSIGN_SHA256', hashlib.sha256(self.binary.read_bytes()).hexdigest()))
        stack.enter_context(patch.object(Path, 'lstat', autospec=True, side_effect=self.trusted_stat))
        stack.enter_context(patch.object(d.subprocess, 'run', side_effect=self.cosign))
        self.fake.verify_signature = d.Deployer.verify_signature.__get__(self.fake)
        return stack

    def files(self):
        return {str(p.relative_to(self.app)): p.read_bytes() for p in self.app.rglob('*') if p.is_file()}

    def test_signed_candidate_and_anchor_valid_exact_policy_clean_env(self):
        self.existing()
        self.fake.command_env.update(COSIGN_REPOSITORY='evil', SIGSTORE_ROOT_FILE='evil', HTTPS_PROXY='evil', SSL_CERT_FILE='evil')
        with self.verification():
            self.fake.run()
        self.assertEqual(self.state()['digest'], DIGEST_B)
        verifies = [args[-1] for args, _ in self.calls if args[1] == 'verify']
        self.assertEqual(verifies, [DIGEST_B, DIGEST_A])
        for _, kwargs in self.calls:
            self.assertLessEqual(kwargs['timeout'], 20)
            self.assertEqual(kwargs['cwd'], '/')
            self.assertFalse(set(kwargs['env']) - {'HOME', 'DOCKER_CONFIG', 'PATH', 'LANG'})
        self.assertEqual(d.IDENTITY, 'https://github.com/spread-one/my-mastra/.github/workflows/ci.yml@refs/heads/main')
        self.assertEqual(d.ISSUER, 'https://token.actions.githubusercontent.com')

    def test_unsigned_wrong_issuer_identity_workflow_ref_nonzero_fail_closed(self):
        self.existing()
        # These cases model Cosign's certificate/signature rejection, NOT crypto tests.
        for reason in ['unsigned', 'issuer', 'identity', 'workflow', 'ref', 'nonzero', 'network']:
            with self.subTest(reason=reason):
                self.reject = {DIGEST_B} if reason in {'unsigned', 'nonzero', 'network'} else set()
                self.certificate_issuer = 'https://evil.invalid' if reason == 'issuer' else d.ISSUER
                self.certificate_identity = {
                    'identity': d.IDENTITY.replace('spread-one', 'other-owner'),
                    'workflow': d.IDENTITY.replace('ci.yml', 'other.yml'),
                    'ref': d.IDENTITY.replace('refs/heads/main', 'refs/heads/feature'),
                }.get(reason, d.IDENTITY)
                self.fake.verified.clear()
                before = self.files()
                with self.verification(), self.assertRaisesRegex(d.Failed, 'signature_verification_failed'):
                    self.fake.run()
                self.assertEqual(before, self.files())
                self.assertEqual(self.fake.running, DIGEST_A)
                self.assertFalse(any('up' in args for args in self.fake.commands))

    def test_unsigned_anchor_blocks_signed_candidate_before_snapshot_journal_pull(self):
        self.existing()
        self.reject = {DIGEST_A}
        before = self.files()
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.run()
        self.assertEqual(before, self.files())
        self.assertFalse(any('pull' in args or 'up' in args for args in self.fake.commands))

    def test_payload_wrong_digest_repository_and_version_fail_closed(self):
        self.existing()
        for attr, value in [('payload_digest', 'sha256:' + '9' * 64), ('payload_repo', 'evil/image'), ('version', 'v2.4.3')]:
            with self.subTest(attr=attr):
                previous = getattr(self, attr)
                setattr(self, attr, value)
                before = self.files()
                with self.verification(), self.assertRaises(d.Failed):
                    self.fake.run()
                self.assertEqual(before, self.files())
                setattr(self, attr, previous)

    def test_verifier_owner_mode_symlink_hash_missing_and_timeout(self):
        self.existing()
        for uid, mode in [(1000, stat.S_IFREG | 0o700), (0, stat.S_IFREG | 0o755), (0, stat.S_IFREG | 0o720), (0, stat.S_IFLNK | 0o700)]:
            self.uid, self.mode = uid, mode
            before = self.files()
            with self.verification(), self.assertRaisesRegex(d.Failed, 'verifier_untrusted'):
                self.fake.run()
            self.assertEqual(before, self.files())
        self.uid, self.mode = 0, stat.S_IFREG | 0o700
        for error in [FileNotFoundError(), subprocess.TimeoutExpired('cosign', 20)]:
            self.error = error
            before = self.files()
            with self.verification(), self.assertRaises(d.Failed):
                self.fake.run()
            self.assertEqual(before, self.files())
        self.error = None
        with self.verification(), patch.object(d, 'COSIGN_SHA256', '0' * 64), self.assertRaisesRegex(d.Failed, 'verifier_untrusted'):
            self.fake.run()
        with self.verification(), patch.object(Path, 'lstat', side_effect=FileNotFoundError()), self.assertRaises(d.Failed):
            self.fake.verify_signature(DIGEST_B)
        with self.verification(), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o777)), self.assertRaisesRegex(d.Failed, 'verifier_untrusted'):
            self.fake.verify_signature(DIGEST_B)

    def test_unchanged_rollback_recovery_and_committed_journal_cannot_bypass(self):
        old = self.existing()
        self.fake.run()
        self.fake.verified.clear()
        self.reject = {DIGEST_B}
        before = self.files()
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.run()
        self.assertEqual(before, self.files())
        self.reject = {DIGEST_A}
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.run(rollback=True)
        self.assertEqual(before, self.files())
        candidate = {key: self.state()[key] for key in ('sha', 'digest', 'snapshot')}
        d.atomic(self.app / 'state/pending.json', {'candidate': candidate, 'previous': old})
        self.reject = {DIGEST_B}
        before = self.files()
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.recover()
        self.assertEqual(before, self.files())
        d.atomic(self.app / 'state/deployed.json', old)
        self.reject = {DIGEST_A}
        before = self.files()
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.recover()
        self.assertEqual(before, self.files())
        self.assertEqual(self.fake.running, DIGEST_B)
        self.reject.clear()
        with self.verification():
            self.fake.recover()
        self.assertEqual(self.fake.running, DIGEST_A)

    def test_entrypoint_signature_error_is_sanitized_and_installer_marker_blocks(self):
        import contextlib
        import io
        self.existing()
        self.reject = {DIGEST_B}
        before = self.files()
        output = io.StringIO()
        with self.verification(), patch.object(d, 'prepare'), patch.object(d, 'Deployer', lambda _env: self.fake), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(output):
            self.assertEqual(d.main(), 1)
        self.assertIn('blocked_existing_unchanged', output.getvalue())
        self.assertNotIn('synthetic', output.getvalue())
        # main's persistent lock inode is coordination, not runtime/state mutation.
        after = self.files()
        after.pop('deploy.lock', None)
        self.assertEqual(before, after)
        d.atomic(self.app / 'install-pending.json', 'interrupted install')
        before = self.files()
        with patch.object(d, 'Deployer', lambda _env: self.fake), patch('sys.argv', ['deploy.py', '--sha', SHA_B, '--digest', DIGEST_B]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(d.main(), 1)
        self.assertIn('blocked_installer_recovery_required', output.getvalue())
        self.assertEqual(before, self.files())

    def test_unsigned_initial_recovery_cannot_stop_or_change_runtime(self):
        candidate = {'sha': SHA_B, 'digest': DIGEST_B, 'snapshot': 'env-new'}
        d.atomic(self.app / 'state/env-new', 'not-read-before-signature')
        d.atomic(self.app / 'state/pending.json', {'candidate': candidate, 'previous': None})
        self.reject = {DIGEST_B}
        before = self.files()
        with self.verification(), self.assertRaises(d.Failed):
            self.fake.recover()
        self.assertEqual(before, self.files())
        self.assertFalse(self.fake.stopped)
