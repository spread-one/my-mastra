#!/usr/bin/env bash
# GitHub-hosted trusted-main only. Never echo auth values or transmit application keys.
set -euo pipefail
export LC_ALL=C
if [[ $# -gt 1 || (${1:-} != '' && ${1:-} != --check) ]]; then echo 'ci deploy_invalid_args'; exit 1; fi
DEPLOY_HOST="${DEPLOY_HOST:-}"
[[ "${TS_CI_TAG:-}" == tag:samkim-ci && "${TS_SERVER_TAG:-}" == tag:samkim-server ]] || { echo 'ci deploy_tags_invalid'; exit 1; }
[[ "${DEPLOY_USER:-}" == samkim-deploy ]] || { echo 'ci deploy_user_invalid'; exit 1; }
[[ ${#DEPLOY_HOST} -le 253 && "${DEPLOY_HOST:-}" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$ ]] || { echo 'ci deploy_host_invalid'; exit 1; }
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'ci deploy_sha_invalid'; exit 1; }
[[ "${DIGEST:-}" =~ ^ghcr\.io/spread-one/my-mastra@sha256:[0-9a-f]{64}$ ]] || { echo 'ci deploy_digest_invalid'; exit 1; }
[[ -n "${TS_OAUTH_CLIENT_ID:-}" && -n "${TS_OAUTH_SECRET:-}" ]] || { echo 'ci deploy_auth_missing'; exit 1; }
if [[ ${1:-} == --check ]]; then echo 'ci deploy_config_ready'; exit 0; fi
# Native Tailscale SSH verifies coordination-advertised host keys; no -i/key, sshd,
# StrictHostKeyChecking=no, SCP/env transfer, or arbitrary remote command interpolation.
# SSH exit status is the actual fixed wrapper/health/rollback result (not just image publication).
set +e
env -u TS_OAUTH_CLIENT_ID -u TS_OAUTH_SECRET timeout --signal=TERM --kill-after=15s 400s tailscale ssh "$DEPLOY_USER@$DEPLOY_HOST" \
  /usr/bin/sudo -n /usr/local/sbin/samkim-deploy "$SHA" "$DIGEST" < /dev/null
RESULT=$?
set -e
if [[ "$RESULT" -eq 0 ]]; then
  echo 'ci deployment_healthy'
else
  echo 'ci deployment_failed_or_unconfirmed'
fi
exit "$RESULT"
