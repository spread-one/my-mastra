#!/usr/bin/env python3
"""Explicit SHA/digest deployment invoked by an authenticated fixed wrapper; no host build."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time

APP = Path(os.environ.get('APP_DIR', '/opt/samkim'))
SOURCE = 'https://github.com/spread-one/my-mastra'
IMAGE = 'ghcr.io/spread-one/my-mastra'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(re.escape(IMAGE) + r'@sha256:[0-9a-f]{64}')
EXECUTABLES = {'git': '/usr/bin/git', 'docker': '/usr/bin/docker'}
ENV_KEYS = {'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'EXA_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'}


class Failed(Exception):
    pass


def atomic(path, value):
    data = value if isinstance(value, str) else json.dumps(value, sort_keys=True) + '\n'
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def private_file(path):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise Failed('private_file_permissions')
        return path.read_text()
    except OSError:
        raise Failed('private_file_missing') from None


def env_text(path):
    values = {}
    for line in private_file(path).splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key not in ENV_KEYS or key in values:
            raise Failed('env_format_invalid')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if re.search(r'[\x00-\x20\x7f\"\'`\\$]', value):
            raise Failed('env_format_invalid')
        values[key] = value
    for key in ('DEEPSEEK_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'):
        value = values.get(key, '')
        if not value or re.search(r'your-|example|placeholder|changeme|todo|[<>]', value, re.I):
            raise Failed('required_keys_invalid')
    if not re.fullmatch(r'xoxb-[A-Za-z0-9-]+', values['SLACK_BOT_TOKEN']) or not re.fullmatch(r'xapp-[A-Za-z0-9-]+', values['SLACK_APP_TOKEN']):
        raise Failed('required_keys_invalid')
    if 'EXA_API_KEY' in values and re.search(r'your-|example|placeholder|changeme|[<>]', values['EXA_API_KEY'], re.I):
        raise Failed('optional_key_invalid')
    if values.get('DEEPSEEK_MODEL') and not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}', values['DEEPSEEK_MODEL']):
        raise Failed('model_invalid')
    return ''.join(f'{key}={value}\n' for key, value in sorted(values.items()))


def read_json(path):
    try:
        return json.loads(private_file(path))
    except (ValueError, TypeError):
        raise Failed('state_invalid') from None


def valid_record(record):
    if not isinstance(record, dict) or not SHA.fullmatch(str(record.get('sha', ''))) or not DIGEST.fullmatch(str(record.get('digest', ''))):
        raise Failed('state_invalid')
    if not re.fullmatch(r'env-[a-zA-Z0-9_-]+', str(record.get('snapshot', ''))):
        raise Failed('state_invalid')
    return record


class Deployer:
    def __init__(self, command_env=None):
        self.command_env = command_env or os.environ.copy()
        # Overall deploy budget; the fixed wrapper also bounds process lifetime.
        self.deadline = time.monotonic() + 240
        self.changed = False
        self.old = None
        self.candidate = None

    def command(self, args, seconds=20):
        seconds = min(seconds, self.deadline - time.monotonic())
        if seconds <= 0:
            raise Failed('deployment_timeout')
        if not args or args[0] not in EXECUTABLES:
            raise Failed('command_not_allowed')
        args = [EXECUTABLES[args[0]], *args[1:]]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=seconds, env=self.command_env, cwd='/')
            if result.returncode:
                raise Failed('command_failed')
            return result.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            raise Failed('command_failed') from None

    def head(self):
        # Public Git smart protocol; single bounded lookup, no PAT/API rate-limit credentials.
        text = self.command(['git', '-c', 'credential.helper=', 'ls-remote', SOURCE + '.git', 'refs/heads/main'], 15)
        lines = text.splitlines()
        if len(lines) != 1:
            raise Failed('main_head_invalid')
        parts = lines[0].split()
        if len(parts) != 2 or not SHA.fullmatch(parts[0]) or parts[1] != 'refs/heads/main':
            raise Failed('main_head_invalid')
        return parts[0]

    def compose(self, *args):
        return self.command(['docker', 'compose', '--project-name', 'my-mastra', '--project-directory', str(APP),
                             '--env-file', str(APP / 'image.env'), '-f', str(APP / 'compose.yaml'), *args], 40)

    def inspect_image(self, ref, sha):
        # Only image metadata; no runtime container env/config/log output.
        text = self.command(['docker', 'image', 'inspect', '--format', '{{json .}}', ref])
        try:
            info = json.loads(text)
            labels = info['Config']['Labels']
            if labels.get('org.opencontainers.image.source') != SOURCE or labels.get('org.opencontainers.image.revision') != sha:
                raise Failed('image_provenance_invalid')
            if info.get('Os') != 'linux' or info.get('Architecture') != 'amd64':
                raise Failed('image_platform_invalid')
            digests = [digest for digest in info.get('RepoDigests', []) if DIGEST.fullmatch(digest)]
            if DIGEST.fullmatch(ref):
                if ref not in digests:
                    raise Failed('image_digest_invalid')
                return ref
            if len(digests) != 1:
                raise Failed('image_digest_invalid')
            return digests[0]
        except (ValueError, KeyError, TypeError, AttributeError):
            raise Failed('image_metadata_invalid') from None

    def health(self, record):
        cid = self.compose('ps', '-q', 'bot')
        if not re.fullmatch(r'[0-9a-f]{12,64}', cid):
            return False
        result = self.command(['docker', 'inspect', '--format',
                               '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}|{{.Config.Image}}', cid])
        return result == 'running|healthy|0|' + record['digest']

    def wait_healthy(self, record):
        # Three healthy samples over >=10 seconds, zero restarts; not merely process alive.
        end = min(self.deadline, time.monotonic() + 65)
        stable = 0
        while time.monotonic() < end:
            try:
                stable = stable + 1 if self.health(record) else 0
            except Failed:
                stable = 0
            if stable >= 3:
                return
            time.sleep(5)
        raise Failed('readiness_failed')

    def activate(self, record):
        valid_record(record)
        text = env_text(APP / 'state' / record['snapshot'])
        atomic(APP / '.env.runtime', text)
        atomic(APP / 'image.env', 'BOT_IMAGE=' + record['digest'] + '\n')
        self.compose('up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'bot')
        self.wait_healthy(record)

    def save_success(self, record, previous):
        # deployed.json is the single commit point; no fallible operation follows within this method.
        atomic(APP / 'state' / 'status.json', {'status': 'healthy', 'sha': record['sha'], 'digest': record['digest']})
        path = APP / 'state' / 'deployed.json'
        old = read_json(path) if path.exists() else {}
        history = []
        for item in [record, *old.get('history', []), *([previous] if previous else [])]:
            valid_record(item)
            if item['digest'] not in {entry['digest'] for entry in history}:
                history.append({key: item[key] for key in ('sha', 'digest', 'snapshot')})
        atomic(path, {**record, 'previous': previous, 'history': history[:3]})

    def clean_snapshots(self):
        state_path = APP / 'state' / 'deployed.json'
        state = read_json(state_path) if state_path.exists() else None
        keep = set()
        if state:
            keep.add(valid_record(state)['snapshot'])
            if state.get('previous'):
                keep.add(valid_record(state['previous'])['snapshot'])
            keep.update(valid_record(item)['snapshot'] for item in state.get('history', []))
        # Only our private app snapshots, never Docker images or other apps' files.
        for path in (APP / 'state').glob('env-*'):
            if path.name not in keep:
                private_file(path)
                path.unlink()

    def recover(self):
        pending = APP / 'state' / 'pending.json'
        if not pending.exists():
            return
        journal = read_json(pending)
        candidate = valid_record(journal['candidate'])
        old = journal.get('previous')
        state_path = APP / 'state' / 'deployed.json'
        state = read_json(state_path) if state_path.exists() else None
        # Successful atomic commit wins, even if a crash preceded journal removal.
        if state and all(state.get(key) == candidate[key] for key in ('sha', 'digest', 'snapshot')):
            pending.unlink()
            return 'committed'
        # Never allow an old transaction to roll back a newer successful deployment.
        if state and (not old or any(state.get(key) != old.get(key) for key in ('sha', 'digest', 'snapshot'))):
            raise Failed('recovery_state_conflict')
        if old:
            self.activate(valid_record(old))
            atomic(APP / 'state' / 'status.json', {'status': 'rolled_back', 'sha': old['sha'], 'digest': old['digest']})
        else:
            # Activation may have been interrupted before image.env existed.
            atomic(APP / 'image.env', 'BOT_IMAGE=' + candidate['digest'] + '\n')
            atomic(APP / '.env.runtime', env_text(APP / 'state' / candidate['snapshot']))
            # No previous healthy deployment: stop only this bot, retain explicit failure.
            self.compose('stop', 'bot')
            atomic(APP / 'state' / 'status.json', {'status': 'failed_initial_no_rollback'})
        pending.unlink()
        return 'rolled_back' if old else 'failed_initial_no_rollback'

    def run(self, sha=None, digest=None, force=False, rollback=False):
        if not rollback and (not isinstance(sha, str) or not SHA.fullmatch(sha) or not isinstance(digest, str) or not DIGEST.fullmatch(digest)):
            raise Failed('candidate_invalid')
        self.recover()
        state_path = APP / 'state' / 'deployed.json'
        state = read_json(state_path) if state_path.exists() else None
        if state:
            valid_record(state)
        self.old = {key: state[key] for key in ('sha', 'digest', 'snapshot')} if state else None
        if rollback:
            if not state or not state.get('previous'):
                raise Failed('no_previous_deployment')
            self.candidate = valid_record(state['previous'])
            env_text(APP / 'state' / self.candidate['snapshot'])
            self.inspect_image(self.candidate['digest'], self.candidate['sha'])
        else:
            # Values stay host-only. Actions supplies only the public SHA and immutable digest.
            text = env_text(APP / '.env')
            if self.head() != sha:
                raise Failed('candidate_not_main')
            if state and state['sha'] == sha and state['digest'] == digest and not force and self.health(state):
                print('deploy unchanged_healthy')
                self.maintenance()
                return
            self.command(['docker', 'pull', '--platform', 'linux/amd64', digest], 80)
            if self.inspect_image(digest, sha) != digest:
                raise Failed('image_digest_invalid')
            if self.head() != sha:
                raise Failed('main_changed_before_activation')
            fd, name = tempfile.mkstemp(prefix='env-', dir=APP / 'state')
            os.close(fd)
            snapshot = Path(name)
            atomic(snapshot, text)
            self.candidate = {'sha': sha, 'digest': digest, 'snapshot': snapshot.name}
        atomic(APP / 'state' / 'pending.json', {'candidate': self.candidate, 'previous': self.old})
        self.changed = True
        self.activate(self.candidate)
        if not rollback and self.head() != self.candidate['sha']:
            raise Failed('main_changed_before_commit')
        self.save_success(self.candidate, self.old)
        self.changed = False  # Commit must never be undone by a later cleanup failure.
        (APP / 'state' / 'pending.json').unlink()
        print('deploy healthy ' + self.candidate['sha'] + ' ' + self.candidate['digest'])
        self.maintenance()

    def container_images(self):
        ids = self.command(['docker', 'ps', '-aq', '--no-trunc']).splitlines()
        images = set()
        for cid in ids:
            if not re.fullmatch(r'[0-9a-f]{64}', cid):
                raise Failed('container_metadata_invalid')
            image = self.command(['docker', 'inspect', '--format', '{{.Image}}', cid])
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
                raise Failed('container_metadata_invalid')
            images.add(image)
        return images

    def retain_images(self):
        # Caller holds the deployment flock; all cleanup is app-specific and non-force.
        state_path = APP / 'state' / 'deployed.json'
        state = read_json(state_path)
        protected = [state, *state.get('history', [])]
        if state.get('previous'):
            protected.append(state['previous'])
        digests = {valid_record(item)['digest'] for item in protected}
        revisions = {item['sha'] for item in protected}
        baseline = json.dumps(state, sort_keys=True)
        ids = set(self.command(['docker', 'image', 'ls', '--no-trunc', '--filter',
                                'label=org.opencontainers.image.source=' + SOURCE, '--format', '{{.ID}}']).splitlines())
        for image_id in sorted(ids):
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
                raise Failed('image_metadata_invalid')
            info = json.loads(self.command(['docker', 'image', 'inspect', '--format', '{{json .}}', image_id]))
            labels = info.get('Config', {}).get('Labels') or {}
            revision = labels.get('org.opencontainers.image.revision', '')
            refs = info.get('RepoDigests') or []
            tags = info.get('RepoTags') or []
            if (info.get('Id') != image_id or labels.get('org.opencontainers.image.source') != SOURCE or not SHA.fullmatch(revision)
                    or info.get('Os') != 'linux' or info.get('Architecture') != 'amd64'
                    or not refs or any(not DIGEST.fullmatch(ref) for ref in refs)
                    or any(not re.fullmatch(re.escape(IMAGE) + ':sha-' + revision, tag) for tag in tags)):
                continue  # Foreign aliases, unknown provenance, or shared images are never removed.
            if revision in revisions or digests.intersection(refs):
                continue
            if json.dumps(read_json(state_path), sort_keys=True) != baseline:
                raise Failed('retention_state_changed')
            if image_id in self.container_images():
                continue
            latest = json.loads(self.command(['docker', 'image', 'inspect', '--format', '{{json .}}', image_id]))
            if latest != info:
                raise Failed('retention_image_changed')
            # Recheck all running/stopped containers immediately before deletion. Docker's
            # non-force removal is the final race guard against newly created containers.
            if image_id in self.container_images():
                continue
            self.command(['docker', 'image', 'rm', image_id])

    def maintenance(self):
        # A disk/permission/reference race must never turn a healthy deploy into a failed job.
        if self.deadline - time.monotonic() <= 25:
            print('deploy retention_deferred')
            return
        deadline = self.deadline
        self.deadline = min(deadline, time.monotonic() + 20)
        try:
            self.clean_snapshots()
            self.retain_images()
            print('deploy retention_complete')
        except (Failed, OSError, ValueError, KeyError, TypeError):
            print('deploy retention_deferred')
        finally:
            self.deadline = deadline


def prepare():
    # The fixed root-only target has three parts; keep shallow operator overrides blocked.
    if (not APP.is_absolute() or str(APP.resolve()) != str(APP)
            or (APP != Path('/opt/samkim') and len(APP.parts) < 4)
            or re.search(r'[^a-zA-Z0-9/_-]', str(APP))):
        raise Failed('app_dir_unsafe')
    info = APP.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Failed('app_dir_permissions')
    state = APP / 'state'
    state.mkdir(mode=0o700, exist_ok=True)
    info = state.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Failed('state_dir_permissions')
    for path in (APP / 'image.env', APP / '.env.runtime', state / 'pending.json', state / 'deployed.json', state / 'status.json'):
        if path.exists() or path.is_symlink():
            private_file(path)


def main():
    parser = argparse.ArgumentParser(description='Explicit main SHA/digest deployer; static sanitized status only')
    parser.add_argument('--sha')
    parser.add_argument('--digest')
    parser.add_argument('--force', action='store_true', help='Redeploy current main, including a changed host .env')
    parser.add_argument('--rollback', action='store_true', help='Root operator only: restore previous local healthy digest/env' )
    args = parser.parse_args()
    if not args.rollback and (not args.sha or not SHA.fullmatch(args.sha) or not args.digest or not DIGEST.fullmatch(args.digest)):
        print('deploy candidate_invalid')
        return 1
    os.umask(0o077)
    deployer = None
    try:
        prepare()
        # All Actions/manual/recovery paths share a persistent inode. Never unlink this lock.
        lock_path = APP / 'deploy.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('deploy locked_busy')
                return 1
            with tempfile.TemporaryDirectory(prefix='my-mastra-docker-') as config:
                env = {key: value for key, value in os.environ.items()
                       if not key.startswith(('COMPOSE_', 'DOCKER_', 'GIT_')) and key not in ENV_KEYS | {'BOT_IMAGE', 'SLACK_HEALTH_FILE'}}
                env.update(HOME=config, DOCKER_CONFIG=config, DOCKER_HOST='unix:///var/run/docker.sock',
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
                deployer = Deployer(env)
                # Interruptions attempt rollback under the same lock; hard kills recover next invocation.
                def terminated(_signum, _frame):
                    raise Failed('deployment_interrupted')
                signal.signal(signal.SIGTERM, terminated)
                try:
                    deployer.run(args.sha, args.digest, args.force, args.rollback)
                except (Failed, OSError, ValueError, KeyError, TypeError) as error:
                    # Failed messages are fixed codes authored here, never SDK/subprocess output.
                    code = str(error) if isinstance(error, Failed) else 'host_operation_failed'
                    print('deploy blocked ' + code)
                    if deployer.changed:
                        # Reserve independent bounded recovery budget even after deploy timeout.
                        deployer.deadline = time.monotonic() + 100
                        signal.signal(signal.SIGTERM, signal.SIG_IGN)
                        try:
                            recovered = deployer.recover()
                            if recovered == 'committed':
                                print('deploy committed_recovery')
                            else:
                                print('deploy failed_rollback_confirmed' if deployer.old else 'deploy failed_initial_no_rollback')
                        except (Failed, OSError, ValueError, KeyError, TypeError):
                            atomic(APP / 'state' / 'status.json', {'status': 'failed_rollback_unconfirmed'})
                            print('deploy failed_rollback_unconfirmed')
                    elif (APP / 'state' / 'pending.json').exists():
                        atomic(APP / 'state' / 'status.json', {'status': 'failed_recovery_unconfirmed'})
                        print('deploy failed_recovery_unconfirmed')
                    else:
                        print('deploy blocked_existing_unchanged')
                    return 1
        return 0
    except (Failed, OSError, ValueError, KeyError, TypeError):
        print('deploy blocked_configuration')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
