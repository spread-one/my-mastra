#!/usr/bin/env bash
# Owner-only bootstrap of fixed files. No account/tailnet/OS changes, builds, or app start.
set -euo pipefail
umask 077
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAGE=""
if [[ $# -eq 2 && "$1" == --stage ]]; then
  STAGE="$2"
  [[ "$STAGE" == /* && -d "$STAGE" && ! -L "$STAGE" ]] || { echo 'install unsafe_stage'; exit 1; }
elif [[ $# -ne 0 ]]; then
  echo 'usage: install.sh [--stage ABSOLUTE_EXISTING_DIRECTORY]'; exit 1
elif [[ "$EUID" -ne 0 ]]; then
  echo 'install root_required'; exit 1
fi
# Fixed app and wrapper paths are part of the privilege boundary, not configurable in CI.
[[ -z "${APP_DIR:-}" || "$APP_DIR" == /opt/samkim ]] || { echo 'install fixed_path_required'; exit 1; }
if [[ -z "$STAGE" ]]; then
  for executable in /usr/bin/python3 /usr/bin/git /usr/bin/docker /usr/bin/timeout /usr/sbin/visudo; do
    [[ -x "$executable" ]] || { echo 'install required_executable_missing'; exit 1; }
    [[ "$(/usr/bin/stat -Lc %u "$executable")" -eq 0 ]] || { echo 'install executable_owner_invalid'; exit 1; }
    [[ -z "$(/usr/bin/find -L "$executable" -perm /022 -print)" ]] || { echo 'install executable_permissions_invalid'; exit 1; }
  done
  /usr/bin/id samkim-deploy >/dev/null
  if /usr/bin/id -nG samkim-deploy | /usr/bin/grep -Eq '(^| )(docker|sudo|wheel)( |$)'; then
    echo 'install privileged_account_rejected'; exit 1
  fi
  /usr/sbin/visudo -cf "$SOURCE_DIR/samkim-deploy.sudoers" >/dev/null
fi
export STAGE SOURCE_DIR
/usr/bin/python3 -I - <<'PY'
import fcntl
import json
import os
from pathlib import Path
import runpy
import stat
import tempfile

stage = os.environ['STAGE']
source = Path(os.environ['SOURCE_DIR'])
target = Path(stage + '/opt/samkim')
wrapper = Path(stage + '/usr/local/sbin/samkim-deploy')
sudoers = Path(stage + '/etc/sudoers.d/samkim-deploy')
for path in (target, wrapper.parent, sudoers.parent):
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise SystemExit('install symlink_path')
        if not stage and parent.exists():
            info = parent.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise SystemExit('install untrusted_parent_path')
if target.exists():
    info = target.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise SystemExit('install app_dir_permissions')
target.mkdir(parents=True, mode=0o700, exist_ok=True)
wrapper.parent.mkdir(parents=True, exist_ok=True)
sudoers.parent.mkdir(parents=True, exist_ok=True)
# This persistent inode is shared with ALL deployment/recovery invocations.
lock_path = target / 'deploy.lock'
if lock_path.exists() or lock_path.is_symlink():
    info = lock_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise SystemExit('install lock_untrusted')
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('install locked_busy')
    marker = target / 'install-pending.json'
    if marker.exists() or marker.is_symlink():
        raise SystemExit('install interrupted_owner_recovery_required')
    pending = target / 'state/pending.json'
    if pending.exists() or pending.is_symlink():
        raise SystemExit('install deployment_recovery_required')
    changes = [(target / name, (source / name).read_bytes(), 0o600)
               for name in ('deploy.py', 'compose.yaml')]
    changes += [(wrapper, (source / 'samkim-deploy').read_bytes(), 0o755),
                (sudoers, (source / 'samkim-deploy.sudoers').read_bytes(), 0o440)]
    # Stage mode is templates-only: never downloads/executes a verifier or touches host.
    if not stage:
        helper = runpy.run_path(str(source / 'cosign_download.py'))
        data = helper['fetch_binary']()
        with tempfile.TemporaryDirectory(prefix='.verifier-', dir=target) as directory:
            binary = Path(directory) / 'cosign'
            binary.write_bytes(data)
            binary.chmod(0o700)
            helper['check_version'](binary)
        changes.append((target / 'cosign', data, 0o700))
    # Complete destination preflight BEFORE the first replacement; snapshot trusted bytes.
    previous = {}
    for dest, data, mode in changes:
        if dest.exists() or dest.is_symlink():
            info = dest.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise SystemExit('install symlink_or_untrusted_file')
            previous[dest] = (dest.read_bytes(), stat.S_IMODE(info.st_mode))
        else:
            previous[dest] = None
    backup = target / 'install-backup'
    if backup.exists() or backup.is_symlink():
        raise SystemExit('install backup_owner_review_required')
    backup.mkdir(mode=0o700)
    def durable(dest, data, mode):
        fd, name = tempfile.mkstemp(prefix='.install-', dir=dest.parent)
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.chmod(name, mode)
            os.replace(name, dest)
            directory = os.open(dest.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    for index, (dest, _, _) in enumerate(changes):
        if previous[dest]:
            durable(backup / str(index), previous[dest][0], 0o600)
    journal = [{'path': str(dest), 'backup': str(index) if previous[dest] else None,
                'mode': previous[dest][1] if previous[dest] else None}
               for index, (dest, _, _) in enumerate(changes)]
    durable(marker, (json.dumps(journal) + '\n').encode(), 0o600)
    try:
        for dest, data, mode in changes:
            durable(dest, data, mode)
    except BaseException:
        # Normal errors restore the whole reviewed boundary, not half an upgrade.
        # A kill/power failure leaves marker + durable backup: deploy refuses to run.
        for dest, _, _ in changes:
            if previous[dest]:
                durable(dest, previous[dest][0], previous[dest][1])
            elif dest.exists():
                dest.unlink()
                directory = os.open(dest.parent, os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        marker.unlink()
        directory = os.open(target, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        raise
    marker.unlink()
    directory = os.open(target, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    # Preserve the previous templates/verifier for OWNER review/manual recovery.
    # No secret/env/state files were included. Remove/move backup before another upgrade.
    print('install fixed_templates_ready_app_not_started')
PY
