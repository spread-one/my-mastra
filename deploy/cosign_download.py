#!/usr/bin/env python3
"""Fetch a reviewed immutable Cosign asset; never execute bytes before SHA256 check."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request

VERSION = 'v2.6.5'
CHECKSUM = 'c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644'
URL = 'https://github.com/sigstore/cosign/releases/download/v2.6.5/cosign-linux-amd64'
MAX_BYTES = 200 * 1024 * 1024


def fetch_binary():
    # Official GitHub release asset redirect to HTTPS release CDN is expected.
    with urllib.request.urlopen(URL, timeout=20) as response:
        if not response.url.startswith('https://'):
            raise ValueError('download_transport')
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != CHECKSUM:
        raise ValueError('download_checksum')
    return data


def check_version(path):
    result = subprocess.run([str(path), 'version', '--json'], env={'PATH': '/usr/bin:/bin'},
                            cwd='/', capture_output=True, timeout=10, check=True)
    if json.loads(result.stdout).get('gitVersion') != VERSION:
        raise ValueError('download_version')


def main():
    if len(sys.argv) != 2:
        return 1
    dest = Path(sys.argv[1]).absolute()
    name = None
    try:
        data = fetch_binary()
        fd, name = tempfile.mkstemp(prefix='.cosign-', dir=dest.parent)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(name, 0o700)
        check_version(Path(name))
        os.replace(name, dest)
        print('cosign pinned_asset_ready')
        return 0
    except Exception:
        print('cosign install_blocked')
        return 1
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


if __name__ == '__main__':
    raise SystemExit(main())
