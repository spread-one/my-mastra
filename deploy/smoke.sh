#!/usr/bin/env bash
# Local image-only smoke; never supply real Slack/provider keys here.
set -euo pipefail
IMAGE="${1:-my-mastra:selfhost-smoke}"
# Parse Compose with isolated synthetic files and --quiet; never render a host's real env/config.
FIXTURE="$(mktemp -d)"
CID=''
cleanup() { if [[ -n "$CID" ]]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi; rm -rf -- "$FIXTURE"; }
trap cleanup EXIT
cp "$(dirname -- "${BASH_SOURCE[0]}")/compose.yaml" "$FIXTURE/compose.yaml"
printf 'DEEPSEEK_API_KEY=synthetic\nSLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n' > "$FIXTURE/.env.runtime"
printf 'BOT_IMAGE=%s\n' "$IMAGE" > "$FIXTURE/image.env"
COMPOSE=(docker compose --project-name my-mastra-smoke --project-directory "$FIXTURE" --env-file "$FIXTURE/image.env" -f "$FIXTURE/compose.yaml")
"${COMPOSE[@]}" config --quiet
# Synthetic config only; assert actual Compose resource parsing, not deploy: reservations.
"${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; b=json.load(sys.stdin)["services"]["bot"]; assert float(b["cpus"]) == 1.0 and int(b["mem_limit"]) == 1073741824 and b["pids_limit"] == 128'
# Real hosted daemon HostConfig check using a keyless, network-disabled test command.
printf 'services:\n  bot:\n    network_mode: none\n' > "$FIXTURE/smoke.yaml"
CID="$("${COMPOSE[@]}" -f "$FIXTURE/smoke.yaml" run -d --no-deps bot node -e 'setInterval(() => {}, 1000)')"
[[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}' "$CID")" == '1000000000|1073741824|128' ]]
docker rm -f "$CID" >/dev/null
CID=''
COMMON=(--cpus 1.0 --memory 1g --pids-limit 128 --rm --platform linux/amd64 --read-only --cap-drop ALL --security-opt no-new-privileges --network none
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=1700
  --tmpfs /run/my-mastra:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700)
docker run "${COMMON[@]}" "$IMAGE" node dist/slack.js --help
docker run "${COMMON[@]}" --entrypoint node "$IMAGE" dist/cli.js --help
docker run "${COMMON[@]}" --entrypoint node "$IMAGE" -e '
  const fs = require("node:fs");
  if (process.getuid() !== 1000) process.exit(1);
  for (const path of ["/app/.env", "/app/.git", "/app/src", "/app/deploy"]) {
    if (fs.existsSync(path)) process.exit(1);
  }
  fs.writeFileSync("/run/my-mastra/check", "ok");
  try { fs.writeFileSync("/app/should-not-write", "no"); process.exit(1); } catch {}
'
set +e
OUTPUT="$(docker run "${COMMON[@]}" "$IMAGE" 2>&1)"
RESULT=$?
set -e
[[ "$RESULT" -eq 1 && "$OUTPUT" == *DEEPSEEK_API_KEY* ]] || { echo 'smoke missing_key_failed'; exit 1; }
# No file means not ready, even if a Node process can run successfully.
set +e
docker run "${COMMON[@]}" --entrypoint node "$IMAGE" dist/slack/health-check.js
RESULT=$?
set -e
[[ "$RESULT" -eq 1 ]] || { echo 'smoke false_health_failed'; exit 1; }
echo 'smoke passed_no_live_slack'
