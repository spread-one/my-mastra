#!/usr/bin/env bash
# Local image-only smoke; never supply real Slack/provider keys here.
set -euo pipefail
IMAGE="${1:-my-mastra:selfhost-smoke}"
# Parse Compose with isolated synthetic files and --quiet; never render a host's real env/config.
FIXTURE="$(mktemp -d)"
trap 'rm -rf -- "$FIXTURE"' EXIT
cp "$(dirname -- "${BASH_SOURCE[0]}")/compose.yaml" "$FIXTURE/compose.yaml"
printf 'DEEPSEEK_API_KEY=synthetic\nSLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n' > "$FIXTURE/.env.runtime"
printf 'BOT_IMAGE=%s\n' "$IMAGE" > "$FIXTURE/image.env"
docker compose --project-name my-mastra-smoke --project-directory "$FIXTURE" --env-file "$FIXTURE/image.env" -f "$FIXTURE/compose.yaml" config --quiet
COMMON=(--rm --platform linux/amd64 --read-only --cap-drop ALL --security-opt no-new-privileges --network none
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
