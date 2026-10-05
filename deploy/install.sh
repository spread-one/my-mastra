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
[[ -z "${APP_DIR:-}" || "$APP_DIR" == /srv/selfhost/apps/my-mastra ]] || { echo 'install fixed_path_required'; exit 1; }
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
import os
from pathlib import Path
import stat
import tempfile

stage = os.environ['STAGE']
source = Path(os.environ['SOURCE_DIR'])
target = Path(stage + '/srv/selfhost/apps/my-mastra')
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
def replace(dest, text, mode):
    if dest.is_symlink():
        raise SystemExit('install symlink_file')
    fd, name = tempfile.mkstemp(prefix='.install-', dir=dest.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(text)
        os.chmod(name, mode)
        os.replace(name, dest)
    finally:
        if os.path.exists(name):
            os.unlink(name)
for name in ('deploy.py', 'compose.yaml'):
    replace(target / name, (source / name).read_text(), 0o600)
replace(wrapper, (source / 'samkim-deploy').read_text(), 0o755)
replace(sudoers, (source / 'samkim-deploy.sudoers').read_text(), 0o440)
print('install fixed_templates_ready_app_not_started')
PY
