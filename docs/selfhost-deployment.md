# SamKim self-host 자동 배포

## 설계와 신뢰 경계

```text
PR / main push → GitHub-hosted check (typecheck/test/build/배포 계약)
                         ↓ needs: check, push + refs/heads/main만
                GitHub-hosted publish → GHCR sha-<40hex>, linux/amd64
                         ↓ anonymous outbound pull
Linux systemd timer → 공개 main HEAD 재조회 → source/revision 검증
                    → RepoDigest 고정 → 앱 bot만 Compose 교체
                    → 실제 Slack 연결 health 안정화 → 성공 state 원자적 commit
                    └ 실패: 이전 healthy digest + 당시 env snapshot 복구
```

공개 저장소의 PR 코드는 GitHub-hosted runner에서만 실행합니다. persistent self-hosted runner, `pull_request_target`, SSH 배포, PAT, 추가 tailnet credentials가 **없습니다**. 저장소 전체 권한은 `contents: read`; **publish job만** `packages: write`이고 `needs: check` 성공 뒤 trusted main push에서 실행합니다. PR/fork에는 publish job이 실행되지 않습니다. 서버는 GitHub와 GHCR에 읽기 전용 outbound 연결만 사용합니다. Docker 인증 설정은 매 실행 빈 임시 `DOCKER_CONFIG`로 격리됩니다.

`ghcr.io/spread-one/my-mastra:sha-<full SHA>`만 발행하고 `latest`는 사용하지 않습니다. 호스트는 `org.opencontainers.image.source=https://github.com/spread-one/my-mastra`, `org.opencontainers.image.revision=<main SHA>`, `linux/amd64`와 해당 저장소의 `sha256:<64hex>` RepoDigest를 검증한 뒤 **digest reference**를 Compose에 넣습니다. 발행 job도 출력 digest의 라벨을 검증하고 summary에 SHA/digest를 기록합니다. BuildKit minimal provenance도 발행됩니다. SHA 태그는 불변을 의도한 이름 규약이지 GHCR 자체의 overwrite 금지 정책이나 서명 검증은 아닙니다. 라벨은 repository/packages 쓰기 권한과 GitHub Actions의 신뢰를 전제로 합니다. main protection/리뷰와 Actions 변경 검토가 필요합니다. 같은 SHA 재발행은 이미 healthy인 서버를 자동 교체하지 않습니다(`--force`가 필요).

## prerequisites — 먼저 owner가 처리

- Linux x86_64, Python 3, Git, Docker Engine, Compose **v2.30 이상** (`env_file.format: raw` 지원), systemd. 시스템 서비스의 기본 Docker socket `/var/run/docker.sock`을 사용합니다.
- Slack Socket Mode의 실제 bot/app token, 실제 `DEEPSEEK_API_KEY`. **DeepSeek 키가 미설정이면 최초 배포도 차단**됩니다. EXA 키는 선택입니다. Slack 권한 설정은 [slack.md](slack.md) 참고.
- GitHub Actions와 GHCR publish 허용. 첫 main publish 뒤 GitHub package owner가 **패키지 visibility를 Public**으로 변경해야 합니다. Public repo여도 최초 패키지는 private일 수 있습니다.
  - GitHub `spread-one` 프로필 → Packages → `my-mastra` → Package settings → Danger Zone → Change package visibility → Public. owner 권한/확인 절차에 따라 처리합니다.
  - 첫 publish/main image 존재와 Actions summary digest를 확인합니다. package linked repository/access 설정도 owner가 확인합니다.
  - anonymous pull이 가능해지기 전에는 timer가 실패해도 기존 봇을 유지합니다. private pull용 PAT를 서버에 추가하는 방식으로 우회하지 않습니다.
- outbound HTTPS/DNS로 공개 GitHub main과 GHCR에 접근 가능해야 합니다. 외부 수신 포트/HTTP readiness endpoint를 열지 않습니다.

이 PR은 템플릿과 로컬 테스트만 제공합니다. 실제 package 공개 전환, 서버 설치/키 전달/Slack live 검증은 owner 작업입니다. 원격 운영 지침, 주소, 사용자, 키를 이 저장소로 복사하지 않습니다.

## host layout / secret 관리

기본 앱 전용 위치는 `/srv/selfhost/apps/my-mastra`입니다. `/srv/selfhost`의 기존 Compose나 다른 앱을 사용하지 않습니다. 프로젝트 `my-mastra` / 서비스 `bot`을 이 앱만 사용해야 합니다. 기존 동일 프로젝트 봇이 있다면 owner가 이전 운영과 충돌 없이 전환해야 합니다.

```text
my-mastra/                  root 소유 0700
  deploy.py, compose.yaml    배포 코드/템플릿
  .env                      host에서 owner가 전달한 키, root 소유 0600 (0400도 가능)
  .env.runtime              현재 activation에 사용한 env, 0600
  image.env                 BOT_IMAGE=ghcr.io/...@sha256:... 만, 0600
  deploy.lock               모든 poll/force/rollback이 공유하는 flock (삭제하지 않음)
  state/                    0700
    deployed.json           마지막 확인된 healthy SHA/digest/snapshot + 이전 record
    pending.json            activation journal (진행/복구 중에만 존재)
    status.json             secret 없는 결과 상태; 실제 container health와 함께 확인
    env-*                   root-only 당시 key snapshot, 0600
```

`.env`는 셸 스크립트로 source하지 않습니다. 허용 키는 `DEEPSEEK_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DEEPSEEK_MODEL`, `EXA_API_KEY`뿐입니다. `KEY=value` 각 한 줄, `#` 주석/빈 줄 허용, 값 전체를 감싸는 단순 따옴표는 제거합니다. export, 중복 키, interpolation, 공백/제어문자, backslash/dollar/backtick/내부 quote는 거부합니다. placeholder나 잘못된 Slack prefix도 거부하고 **키 이름/원문은 로그에 출력하지 않습니다**. Compose `raw` env_file로 SDK에 literal 값을 전달합니다. 파일/snapshot은 symlink가 아니어야 하며 실행 사용자 소유이고 group/other 읽기 권한이 없어야 합니다. APP_DIR도 canonical 절대 경로, 충분히 깊은 경로, 안전한 문자, 실행 사용자 소유 0700이어야 합니다. 사용자 지정 APP_DIR은 새 템플릿 설치 시 서비스에 함께 반영합니다.

Docker는 원래 privileged operator가 container env를 inspect할 수 있는 경계입니다. root/Docker 권한자를 신뢰해야 합니다. 상태 JSON에는 키가 없지만 env snapshot은 **키 사본**이므로 백업/접근을 제한합니다. 성공 후 현재/이전 snapshot 두 개 외에는 앱 state의 `env-*`만 정리합니다. 실패/중단 중 snapshot은 다음 성공까지 남을 수 있습니다. Docker images는 자동 prune하지 않습니다. rollback을 위해 이전 digest를 로컬에 유지하세요.

`.dockerignore`는 allowlist로 package/lock/tsconfig/production source만 전달합니다. `.env`, git, node_modules, credentials, 배포/문서는 build context에 없습니다. secret build-arg, BuildKit secret, remote cache upload는 사용하지 않습니다. Node 24 multistage에서 lock 기반 `npm ci` build/prod dependencies를 분리합니다. 런타임은 UID 1000, tini + Compose init, read-only rootfs, tmpfs, cap drop, no-new-privileges, no published ports, rotated stdout/stderr logs입니다.

## bootstrap (owner가 승인된 호스트에서 실행)

검토/merge된 저장소 사본의 `deploy/`에서 템플릿을 설치합니다. **이 명령들은 현재 PR에서 실행하지 않았습니다.** 부모 디렉터리/기존 서비스 상태와 동시에 작업 중인 운영 세션을 먼저 확인하세요.

```bash
# 시스템 설정/Windows/SSH/Tailscale 변경 없이 앱 템플릿만 설치
sudo bash deploy/install.sh
# 사용자 지정 경로가 필요할 때: sudo APP_DIR=/srv/selfhost/apps/my-mastra-test bash deploy/install.sh
```

installer는 앱 폴더/스크립트/Compose와 두 systemd unit을 설치하고 daemon-reload만 합니다. `.env`/state를 만들거나 덮지 않고, timer를 enable/start하지 않습니다. `.env`를 안전한 비로그 전송/편집 방법으로 owner가 준비하고 소유권/권한만 확인합니다. 키를 shell history, 커맨드라인, PR/Actions secrets, Git에 입력하지 않습니다.

```bash
sudo chown root:root /srv/selfhost/apps/my-mastra/.env
sudo chmod 600 /srv/selfhost/apps/my-mastra/.env
# 실제 키 확보 / GHCR public / Docker 준비 후 최초 1회
sudo systemctl start my-mastra-deploy.service
sudo systemctl status my-mastra-deploy.service --no-pager
sudo cat /srv/selfhost/apps/my-mastra/state/status.json
# 최초 healthy와 실제 Slack 답변을 owner가 확인한 뒤
sudo systemctl enable --now my-mastra-deploy.timer
systemctl list-timers my-mastra-deploy.timer
```

필요 시 먼저 무인증으로 읽을 수 있는지 검증합니다. SHA는 공개 main의 40자리 SHA로 바꾸며 실제 키는 사용하지 않습니다. `docker pull`로 해당 앱 이미지 하나만 읽습니다.

```bash
CONFIG=$(mktemp -d)
sudo docker --config "$CONFIG" pull --platform linux/amd64 ghcr.io/spread-one/my-mastra:sha-<FULL_MAIN_SHA>
rmdir "$CONFIG"
```

## poll / readiness / rollback 동작

- boot 후 약45초, 완료 후60초 + 최대10초 accuracy/jitter로 재시도합니다. 이미지 발행/visibility/네트워크/Slack 연결 시간이 추가됩니다. **main merge 직후 즉시 배포되거나 모든 중간 commit이 배포된다는 보장은 없습니다.** 각 poll은 최신 public main HEAD에 해당하는 image만 수용합니다.
- 기존 healthy SHA이면 skip합니다. `.env` 변경은 자동 적용하지 않으므로 `--force`를 사용합니다. 기존 상태가 unhealthy/재시작됨이면 같은 SHA라도 재배포해 readiness를 다시 검증합니다.
- `git ls-remote` 한 번을 15초로 제한합니다. main image 없거나 CI/publish 실패, metadata/label/digest/platform 오류, key validation 실패, 네트워크 오류이면 기존 서비스/state를 건드리지 않습니다. failed service는 다음 timer에서 다시 시도합니다. Docker command/pull/health와 전체 실행도 제한합니다(배포240초, 실패 복구 최대100초, systemd start360초/stop110초).
- 모든 명령은 동일 nonblocking `flock`을 사용합니다. 중복 실행은 skip하며 오래된 journal은 다음 실행에서 먼저 복구합니다. main HEAD를 pull/metadata 검증 뒤 activation 전에, readiness 뒤 commit 전에 다시 확인합니다. 변경됐으면 activation을 하지 않거나 이전 상태로 복구합니다. 외부 Git ref와 로컬 교체를 하나의 원자 transaction으로 만들 수는 없으므로 마지막 HEAD 검사 직후의 변경은 다음 poll에서 따라갑니다.
- image/env snapshot을 journal에 기록한 뒤 `docker compose ... up -d --no-deps --force-recreate --pull never bot`만 수행합니다. 다른 앱 `down`, `prune`, reset, daemon restart는 하지 않습니다. 교체 동안 단일 봇의 짧은 downtime이 있습니다. blue/green 동시 Socket 연결로 인한 중복 처리를 피합니다.
- `SlackSession.start()` 완료 + Slack SDK의 **hello 이후 connected event** + 현재 WebSocket `isActive()`가 모두 참이어야 합니다. close/reconnecting/disconnected/stop은 준비 상태를 해제합니다. 2초마다 token 없는 `{ready,time}` 파일을 tmpfs에 atomic 갱신하고 healthcheck는 10초 이상 오래된 파일도 거부합니다. 별도 HTTP 서버/포트는 없습니다. Bolt 4 / socket-mode의 공개 `SocketModeReceiver.client`와 `websocket.isActive()` API를 사용합니다. Bolt가 SocketModeClient로 전달하는 public `installerOptions.clientOptions`에도 API timeout/retries=0을 설정합니다. OAuth credentials/custom routes는 설정하지 않으므로 installer/HTTP 서버가 생성되지 않습니다. startup 전체는30초, stop은5초로 제한하며 정상 운영의 Socket 재연결은 SDK가 담당합니다.
- Docker `running/healthy`, image digest 일치, `RestartCount=0`을 세 번(최소10초) 확인합니다. 준비 확인은 약65초로 제한합니다. 단순 process alive나 start 로그만으로 성공하지 않습니다. 이후 Docker health는 연결 상태를 계속 보여주지만 Docker는 **unhealthy만으로 자동 restart하지 않습니다**. timer의 다음 poll이 복구를 시도합니다. socket SDK ping/pong timeout이 죽은 연결을 인지하기까지 지연될 수 있습니다. SDK 정상 reconnect는 허용합니다.
- 실패 시 이전 digest와 **그때의 env snapshot**을 복구하고 똑같은 health 안정화 검사를 합니다. `deployed.json`은 성공 시만 atomic replace합니다. 실패한 후보는 successful state에 쓰지 않습니다. rollback 확인 실패는 `failed_rollback_unconfirmed`와 journal을 남깁니다. 첫 배포 실패는 bot만 stop하고 `failed_initial_no_rollback`, successful state 없음으로 남깁니다.
- 강제 종료 후 journal이 있으면 다음 poll에서 복구합니다. 이미 commit된 candidate journal은 정리만 하고, state가 다른 더 최신 성공 record이면 `recovery_state_conflict`로 막습니다. 오래된 rollback이 새 성공 상태를 덮지 않습니다. 디스크/권한/Docker 장애가 복구도 막으면 state는 **마지막 성공 기록일 뿐 실제 실행 상태가 아닙니다**. 항상 현재 container health/image와 status를 함께 확인하세요.

Slack 연결 readiness는 실제 model 응답/API key 유효성, bot scope, 채널 권한, 외부 웹/tool 기능까지 검증하지 않습니다. 최초/변경 배포 후 owner의 Slack live 답변 검증이 필요합니다. startup/stop은 기존 timeout과 SIGINT/SIGTERM shutdown을 유지하며 SDK arbitrary error/payload는 로그에 쓰지 않습니다. 실행 entry의 마지막 방어선도 late uncaughtException/unhandledRejection을 고정 code로만 기록하고 정상 bounded shutdown을 거쳐 exit 1로 끝냅니다(라이브러리 import에 전역 handler를 설치하지 않음). 시작·실패 등 고정 code만 기록합니다.

## 운영 명령

```bash
# 자동 업데이트 멈춤 (봇은 계속 실행)
sudo systemctl disable --now my-mastra-deploy.timer
# in-flight 교체가 있다면 취소/rollback을 기다림
sudo systemctl stop my-mastra-deploy.service

# 현재 main 재배포 / owner가 안전하게 교체한 .env 반영
sudo python3 /srv/selfhost/apps/my-mastra/deploy.py --force

# 이전 성공 digest/env로 수동 복구. timer를 먼저 끄지 않으면 다음 poll이 main을 다시 배포함
sudo python3 /srv/selfhost/apps/my-mastra/deploy.py --rollback

# 다시 자동 poll
sudo systemctl enable --now my-mastra-deploy.timer

# 배포 도구/Compose 템플릿 업데이트 (앱 image 배포와 별개)
# timer disable + service stop 후, 새 검토된 저장소 사본에서:
sudo bash deploy/install.sh
sudo systemctl start my-mastra-deploy.service
# healthy 확인 후 timer enable

# secret 없는 배포 상태/로그
sudo cat /srv/selfhost/apps/my-mastra/state/deployed.json
sudo cat /srv/selfhost/apps/my-mastra/state/status.json
sudo journalctl -u my-mastra-deploy.service --since '10 minutes ago' --no-pager
sudo docker ps --filter label=com.docker.compose.project=my-mastra
```

봇 자체를 멈추려면 timer/service를 먼저 멈춘 뒤 앱 경로의 bot만 stop합니다:

```bash
sudo docker compose --project-name my-mastra --project-directory /srv/selfhost/apps/my-mastra \
  --env-file /srv/selfhost/apps/my-mastra/image.env -f /srv/selfhost/apps/my-mastra/compose.yaml stop bot
```

`docker compose config`, full `docker inspect`, `.env`/snapshot cat, 임의 payload가 있는 SDK debug logs는 공유하지 마세요. timer disable만으로 이미 시작된 deploy가 취소되지는 않습니다. 수동 명령에도 기본 APP_DIR 또는 같은 안전한 `APP_DIR` override를 사용합니다. lock 파일을 삭제하거나 Docker 상태를 수동 변경하며 deploy와 경쟁하지 마세요.

## WSL / 운영 한계

`restart: unless-stopped`는 Docker daemon이 실제로 시작됐을 때 기존 container를 재시작합니다. systemd timer는 **Linux/systemd가 실행 중일 때만** poll합니다. Windows sleep/전원 종료/재부팅, WSL 자동 시작, Docker/systemd 자동 시작은 별도 운영 승인/설정이 필요합니다. 이 구현은 Windows always-on, OS/WSL 종료·재부팅, SSH/Tailscale, 외부 포트, 다른 앱의 서비스를 변경하지 않습니다. daemon 재시작 후 container health와 timer를 owner가 확인하세요.

## 검증 범위

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
node dist/slack.js --help
npm run test:deployment
# Docker가 있는 로컬 환경 (production keys 불필요)
docker build --platform linux/amd64 --build-arg VCS_REF="$(git rev-parse HEAD)" -t my-mastra:selfhost-smoke .
bash deploy/smoke.sh my-mastra:selfhost-smoke
```

TS tests는 기존 CLI/웹/Slack 회귀와 synthetic Socket SDK/health transitions를, Python fixtures는 fake Docker/Git 명령 및 시간으로 key validation/metadata/락/stale-main/ready/rollback/crash-state/설치경로/privilege 계약을 검증합니다. 실행 entry 테스트는 env 로딩과 transport만 synthetic 대체한 실제 자식 프로세스로 SIGINT/SIGTERM 및 late failure의 종료/로그 안전성을 확인합니다. local Docker smoke는 isolated synthetic Compose parse(`--quiet`), nonroot/read-only/tmpfs/help/missing-key/false-health를 검증합니다. 실제 Actions publish/GHCR anonymous pull, systemd install, Slack 네트워크 E2E, WSL reboot/자동기동 검증과는 구분해야 합니다. 검증 명령을 실행할 때 각각60초 이하로 제한하고, slow Docker download/build는 timeout 결과와 재실행 여부를 따로 기록하세요.
