#!/usr/bin/env bash
# Install templates only. Does not write credentials, start Docker, or enable/start units.
set -euo pipefail
umask 077
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/srv/selfhost/apps/my-mastra}"
STAGE=""
if [[ $# -eq 2 && "$1" == --stage ]]; then
  STAGE="$2"
  [[ "$STAGE" == /* && -d "$STAGE" && ! -L "$STAGE" ]] || { echo 'install unsafe_stage'; exit 1; }
elif [[ $# -ne 0 ]]; then
  echo 'usage: install.sh [--stage ABSOLUTE_EXISTING_DIRECTORY]'; exit 1
elif [[ "$EUID" -ne 0 ]]; then
  echo 'install root_required'; exit 1
fi
export APP_DIR STAGE SOURCE_DIR
python3 - <<'PY'
import os
from pathlib import Path
import re
import stat
import tempfile

app = os.environ['APP_DIR']
if not re.fullmatch(r'/[a-zA-Z0-9/_-]+', app) or len(Path(app).parts) < 4 or str(Path(app).resolve()) != app:
    raise SystemExit('install unsafe_app_dir')
stage = os.environ['STAGE']
source = Path(os.environ['SOURCE_DIR'])
target = Path(stage + app)
units = Path(stage + '/etc/systemd/system')
# Reject symlink path components before creating/writing anything.
for path in (target, units):
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise SystemExit('install symlink_path')
if target.exists():
    info = target.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise SystemExit('install app_dir_permissions')
target.mkdir(parents=True, mode=0o700, exist_ok=True)
units.mkdir(parents=True, exist_ok=True)
def replace(dest, text, mode):
    if dest.is_symlink():
        raise SystemExit('install symlink_file')
    fd, name = tempfile.mkstemp(prefix='.install-', dir=dest.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(text)
        os.chmod(name, mode)
        os.replace(name, dest)  # New owner inode; do not follow existing hardlinks.
    finally:
        if os.path.exists(name):
            os.unlink(name)
for name in ('deploy.py', 'compose.yaml'):
    replace(target / name, (source / name).read_text(), 0o600)
for name in ('my-mastra-deploy.service', 'my-mastra-deploy.timer'):
    replace(units / name, (source / name).read_text().replace('@APP_DIR@', app), 0o644)
print('install templates_ready_timer_not_started')
PY
if [[ -z "$STAGE" ]]; then
  systemctl daemon-reload
fi
