# SamKim: GitHub Actions 직접 배포

## 현재 설계 / 실행 경계

```text
PR / main push -> GitHub-hosted check (typecheck/test/build/배포 계약)
                       -> main push ONLY + needs: check
                       -> GHCR full-SHA linux/amd64 build/publish
                       -> deploy job (contents:read only, selfhost environment)
                       -> ephemeral tag:samkim-ci Tailscale OAuth node
                       -> native tailscale ssh samkim-deploy@DEPLOY_HOST
                       -> sudo -n /usr/local/sbin/samkim-deploy SHA IMAGE@DIGEST
                       -> fixed root-owned host script / single bot Compose
                       -> Slack readiness + stable restart count / rollback
                       -> actual remote exit status -> Actions deploy job result
```

**이미지 빌드는 GitHub-hosted Actions에서만 합니다.** 서버에는 Dockerfile/source checkout/build/npm install/runner가 없습니다. 호스트는 공개 GHCR digest image를 pull하고 bot만 교체합니다. polling/systemd timer는 제거했습니다. 공개 PR/fork에는 publish/deploy/OAuth 연결이 실행되지 않으며 persistent self-hosted runner, public inbound ports, 일반 sshd/SSH key/hostkey bypass도 없습니다. 원격 인증은 Tailscale node identity, ACL/SSH policy, coordination server가 배포하는 SSH host key를 사용합니다.

권한: 전역 `contents: read`; main publish job만 `packages: write`; deploy job은 `contents: read`만 갖습니다. `selfhost` GitHub environment는 owner가 secrets/vars 및 승인 정책을 관리합니다. SHA 태그는 불변을 의도한 이름 규약이며 registry overwrite 금지나 서명은 아닙니다. source/revision labels, digest와 repository/package writer 신뢰를 함께 사용합니다. branch protection/Actions 리뷰는 필요합니다.

**현재 live deploy는 OAuth credentials, tailnet policy/server tags/전용 계정/bootstrap가 준비되지 않아 blocked입니다.** main owner가 로컬 DeepSeek 키를 확보했으며 worker는 그 키를 읽거나 전송하지 않았습니다. 확보와 서버 전달/실제 Slack 검증은 다릅니다. app 키는 host-only이고 Actions에 넣지 않습니다. 이 PR의 tests는 synthetic/mock이며 실제 SSH/Slack/WSL E2E 성공을 뜻하지 않습니다.

## 인증 준비 — owner 작업 (worker는 원격 변경하지 않음)

1. 기존 서버는 Tailscale native SSH (`RunSSH=true`)를 사용합니다. 일반 sshd 설치/활성화, SSH private key/authorized_keys, 임의 hostkey 우회를 추가하지 않습니다.
2. CI source는 `tag:samkim-ci`, target은 `tag:samkim-server`. **tagged -> SSH는 target도 tagged여야 합니다.** owner가 tailnet policy를 먼저 검토하고 기존 관리자 Mac -> target SSH 권한을 명시적으로 보존/검증한 뒤 target tag를 변경해야 합니다. `autogroup:self`는 서버가 tagged가 되면 기존 방식으로 매칭되지 않을 수 있습니다. 접근 복구 경로/관리자 세션 없이 tagging하지 마세요.
3. `deploy/tailnet-policy.example.hujson`은 추가 규칙의 placeholder **fragment**입니다. 기존 policy 전체를 덮지 않습니다. network grants는 CI -> target `tcp:22`만, SSH users는 `samkim-deploy` 하나로 제한합니다. CI에 `root`/`autogroup:nonroot`나 대화형 `check`를 허용하지 않습니다. 기존 broad grants/SSH rules가 추가 권한을 줄 수 있으므로 owner가 함께 audit합니다. administrator rule은 기존 실제 identity/OS user에 맞춰 유지합니다. Tailscale 정책/서버 tag/RunSSH를 worker가 변경하지 않았습니다.
4. OAuth client는 ephemeral tagged node를 만들 수 있는 최소 auth-key scope 및 `tag:samkim-ci`만 부여합니다. CI client에 server tag 적용 권한, tailnet ACL 관리, 광범위 device 관리 권한을 주지 않습니다. 실제 OAuth scope/tag-owner 제약은 owner가 콘솔에서 확인합니다. 이 PR은 official pinned Tailscale action v3/OAuth를 사용하고 memory state/userspace networking/no accepted subnet routes, connect retry 1을 설정합니다. job 마지막에는 bounded logout을 시도합니다.
5. OS 계정 `samkim-deploy`를 owner가 준비합니다. interactive shell은 native SSH의 고정 명령 실행에 필요하지만 **docker group/일반 sudo/root access는 금지**합니다. app dir를 읽거나 수정할 수 없어야 합니다. native Tailscale SSH가 OS user/command access를 제한하며 일반 SSH daemon은 필요하지 않습니다.
6. root가 검토된 템플릿을 설치합니다. `/srv/selfhost/apps/my-mastra`와 `.env`/code/Compose/state는 root-owned, app dir 0700/secret files 0600. `/usr/local/sbin/samkim-deploy`는 root-owned 0755, `/etc/sudoers.d/samkim-deploy` root-owned 0440. sudoers는 이 wrapper 하나만 NOPASSWD/NOSETENV, env_reset/secure_path로 허용합니다. installer는 계정/tag/policy를 생성/변경하지 않고, 이미 준비된 전용 계정의 위험 그룹을 거부합니다. 다른 sudoers/그룹 멤버십까지 owner가 audit해야 합니다.

Wrapper는 **정확히 SHA 40 lowercase hex + ghcr.io/spread-one/my-mastra@sha256:64 lowercase hex 두 argv만** 허용합니다. `--force`, `--rollback`, APP_DIR/repo/Docker/path/command overrides, 공백/셸문자/추가 argv는 거부합니다. shell range는 ASCII locale로 검증하고 `env -i` + fixed PATH/absolute binaries + Python `-I`로 APP_DIR/PYTHONPATH/GIT/DOCKER/COMPOSE/environment 주입을 차단합니다. root operator의 직접 CLI/rollback과 CI의 sudo wrapper 경계를 구분합니다. wrapper는 cwd도 `/`로 고정하고 host script는 Docker/Git을 `/usr/bin/docker`, `/usr/bin/git` 절대 경로로만 실행합니다. installer는 실제 trusted binaries와 대상의 모든 parent가 root-owned/non-group-other-writable인지 검증하며 불일치 시 부모 권한을 자동 변경하지 않고 거부합니다. root script/Compose가 user-writable이면 이 경계가 무너지므로 설치/업데이트 권한을 지켜야 합니다.

### GitHub selfhost environment configuration

| 유형 | 이름 | 값/용도 |
| --- | --- | --- |
| Repository secret | `TS_OAUTH_CLIENT_ID` | 최소 tag 권한의 OAuth client ID |
| Repository secret | `TS_OAUTH_SECRET` | 해당 OAuth secret; 로그/PR에 기재하지 않음 |
| Variable | `DEPLOY_HOST` | owner 승인된 서버 MagicDNS name; 코드/문서에 실제 주소를 복사하지 않음 |
| Variable | `DEPLOY_USER` | `samkim-deploy` 고정 |
| Variable | `TS_CI_TAG` | `tag:samkim-ci` 고정 allowlist |
| Variable | `TS_SERVER_TAG` | `tag:samkim-server` 고정 allowlist (owner policy와 일치) |

누락/잘못된 host/user/SHA/digest/auth는 연결 전에 고정 code로 fail-fast합니다. credentials를 임시 key 파일이나 remote shell/env/SCP로 전달하지 않습니다. remote에는 공개 SHA/digest만 전송합니다. Slack/DeepSeek/EXA 키는 GitHub secrets가 아니라 root-only host `.env`에 둡니다. 환경 승인 gate를 쓰면 자동 배포는 그 승인까지 기다립니다. credential 미설정, 정책 거부, 서버 offline, remote busy/stale candidate/readiness failure/불확실 rollback은 job failure이지 성공/skip이 아닙니다.

## 패키지 / host prerequisites

- Linux x86_64, Python 3, Git, GNU timeout, Docker Engine 및 Compose v2.30+ (`env_file.format: raw` 지원). 기본 Docker socket `/var/run/docker.sock`을 사용합니다. 일반 sudo/visudo와 계정 준비는 owner가 승인된 환경에서 처리합니다.
- 실제 DeepSeek/Slack Socket Mode bot/app token. optional EXA/model. Slack 설치/권한은 [slack.md](slack.md).
- owner가 첫 main publish 뒤 GitHub profile -> Packages -> `my-mastra` -> Package settings -> Change visibility를 **Public**으로 설정합니다. public repo라고 package도 public인 것은 아닙니다. linked repository/package Actions access도 확인합니다. 서버 pull은 빈 임시 DOCKER_CONFIG의 anonymous public pull만 사용하며 PAT를 추가하지 않습니다.
- Tailscale client/server 연결과 outbound GitHub/GHCR/DNS가 필요합니다. 이미 운영 중인 관리 연결/다른 서비스를 변경하지 않습니다. `/srv/selfhost`의 다른 Compose를 사용하지 않고 app 전용 project `my-mastra`/service `bot`만 사용합니다. 같은 project name을 다른 앱과 공유하지 마세요.

## bootstrap / 업데이트 (owner만 실행)

```bash
# 먼저 계정/정책/태깅/관리자 연결을 승인하고 준비. 검토된 저장소 사본에서:
sudo bash deploy/install.sh
# owner가 비로그 안전한 방법으로 host .env 전달 후 소유권/권한만 확인
sudo chown root:root /srv/selfhost/apps/my-mastra/.env
sudo chmod 600 /srv/selfhost/apps/my-mastra/.env
# sudoers 구문/실제 허용 명령 확인 (비밀번호/키를 출력하지 않음)
sudo visudo -cf /etc/sudoers.d/samkim-deploy
sudo -l -U samkim-deploy
```

installer는 root 코드/Compose/고정 wrapper/단일 sudoers만 설치하며 env/state/계정/tailnet/서비스를 덮거나 앱을 시작하지 않습니다. 앱 dir override는 허용하지 않습니다. `--stage ABSOLUTE_DIRECTORY`는 로컬 fixture 설치용이며 실제 account/sudoers 적용이 아닙니다. 업데이트는 in-flight deploy가 없는 상태에서 owner가 같은 installer를 실행하고 native SSH 배포를 재검증합니다. 이전 제출본 timer는 서버에 설치하지 않았습니다. 혹시 별도로 설치된 환경이면 owner가 먼저 disable/stop/remove하고 중복 운영하지 않아야 합니다.

`.env`는 source하지 않습니다. 허용 키는 `DEEPSEEK_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DEEPSEEK_MODEL`, `EXA_API_KEY`; `KEY=value` 각 한 줄, 빈 줄/# 주석과 단순 enclosing quotes는 허용합니다. export/중복/interpolation/내부 whitespace/control/dollar/backtick/backslash/quote/placeholder는 거부합니다. 실제 키 원문은 로그에 쓰지 않습니다. root-only env snapshot은 **키 사본**이므로 접근/백업도 보호합니다. privileged Docker/root operator는 container env를 읽을 수 있는 신뢰 경계입니다. `.dockerignore` allowlist가 credentials/env/git/node_modules/host state를 image context에서 제외합니다. secret buildargs/cache upload/image layer는 없습니다.

## 배포 transaction / readiness / 상태

- Actions가 publish 출력의 explicit SHA/digest를 전송합니다. 서버는 후보가 현재 public main HEAD인지 시작 때, pull/labels 검사 후 activation 전에, readiness 뒤 commit 전에 재확인합니다. old workflow 재실행으로 main이 뒤로 돌아가지 않습니다. 외부 Git ref와 로컬 교체의 원자성이 없으므로 마지막 검사 직후 ref 변경은 다음 main workflow가 처리합니다. 서버의 폴링 보정은 없습니다.
- 동일 healthy SHA **및 digest**이면 skip하지만 성공 상태를 확인한 경우에만 exit 0입니다. shared nonblocking flock은 busy 시 exit 1입니다. 후보 이미지 없거나 key/label/digest/platform/네트워크 오류는 기존 봇/state를 보존합니다. publish와 deploy 결과는 별개이며 publish만 성공한 것은 배포 성공이 아닙니다.
- fixed digest-pinned Compose로 `up -d --no-deps --force-recreate --pull never bot`만 실행합니다. 단일 bot 교체 downtime이 있을 수 있습니다. read-only/nonroot/tini+init/tmpfs/cap drop/no-new-privileges/unless-stopped/no published ports/log rotation을 유지합니다. 다른 앱 down/prune/reset/daemon restart/build는 없습니다.
- Slack start 완료 + SDK hello connected + 현재 `websocket.isActive()`가 준비 증거입니다. 2초마다 secret 없는 tmpfs `{ready,time}`를 atomic 갱신; stale(10초)/close/reconnect/stop은 unhealthy. running/healthy + pinned image + RestartCount=0을 세 번/최소10초 안정화(약65초 제한)한 뒤만 state commit합니다. process alive/start 로그만으로 성공하지 않습니다.
- 실패 시 이전 healthy digest와 당시 env snapshot을 복구하고 동일 readiness 검사를 합니다. 최초 실패는 bot만 stop/`failed_initial_no_rollback`; rollback 불확실이면 journal과 `failed_rollback_unconfirmed`. `deployed.json`은 성공 시만 atomic commit하며 이전 journal이 더 최신 성공 state를 덮지 않습니다. hard kill 후 복구는 **다음 Actions/owner invocation** 때 수행하며 timer가 없습니다.
- host commands/deployment/recovery/SSH/job은 각각 bounded입니다. SIGTERM은 정상 rollback을 시도하고 timeout kill 후 status는 unconfirmed일 수 있습니다. SSH timeout/lost connection은 서버가 실제로 실패했다는 증거가 아니라 **결과 미확인**이므로 Actions는 failure로 표시하고 owner가 확인합니다.
- `state/deployed.json`은 마지막 healthy SHA/digest/snapshot/previous/history이고 `status.json`은 secret 없는 결과입니다. `image.env`는 현재 activation digest, `.env.runtime`은 현재 activation env, `pending.json`은 journal, `env-*`는 보호된 snapshot, `deploy.lock`은 삭제하면 안 되는 persistent flock inode입니다. 마지막 successful state가 지금 살아 있는 container라는 보장은 없으므로 status/container health를 함께 확인합니다.
- health는 Socket 연결이지 DeepSeek 키의 공급자 유효성/Slack scopes/model/web tools 실제 응답 E2E가 아닙니다. owner가 live 답변 검증을 해야 합니다. SDK payload/error는 고정 code로만 로그하며 executable late failure도 bounded shutdown/exit 1로 처리합니다. 라이브러리 import에 전역 handler를 설치하지 않습니다.

## 이미지 retention

Local cleanup은 successful/unchanged-healthy 배포 뒤 동일 flock 안에서 **현재 + rollback을 항상 보호하고 최근 성공 digest 3개**를 유지합니다. 보호 record가 history 밖이면 세 개보다 많을 수 있습니다. source/revision/amd64/digest/모든 tag가 앱 전용임을 검증한 과거 image id만 대상으로 합니다. 다른 repository alias/unknown provenance/모든 running·stopped container가 참조한 image는 보존합니다. state/image metadata와 container references를 삭제 직전에 재검사하고 **non-force `docker image rm ID`**만 사용합니다. race/ref 충돌/권한/시간 초과는 `retention_deferred`이지 deployment 실패가 아닙니다. 실패 배포/rollback 중에는 GC하지 않습니다. global image/system/builder prune은 없습니다. 현재/이전/최근 성공 env snapshots도 보호합니다.

Registry는 별도 `.github/workflows/registry-retention.yml`의 daily schedule / owner `workflow_dispatch` main-only job에서 자동 정리합니다. 해당 job만 `packages:write`이며 delivery workflow에 needs로 연결되지 않아 cleanup 실패가 publish/remote deploy 결과를 바꾸지 않습니다. publish와 cleanup은 **동일 `samkim-ghcr-mutation` concurrency group**을 사용합니다. 이 앱 package의 모든 추가 workflow/publisher도 같은 lock 및 immutable full-SHA tag 계약을 따라야 합니다. GitHub concurrency는 외부/수동 publication까지 잠그지 못합니다.

`deploy/registry_cleanup.py`는 package/repo/API를 하드코드 allowlist로 고정하고 args로 arbitrary package를 삭제하지 않습니다. public/repository linkage를 확인하고 anonymous OCI manifest/config SHA256 검증으로 graph를 읽습니다. 최신 main HEAD, **최근10 app-owned full-SHA roots + 24h grace + 현재 main root**의 recursive closure를 보호합니다. foreign/multiple/unknown tags와 unknown orphan roots의 모든 dependencies도 보호합니다. index의 single linux/amd64 config source/revision이 SHA와 일치해야 app-owned입니다. legacy attestation의 `os=unknown` config는 안전한 ownership 증명을 하지 않고 전체 root/child closure를 foreign/unknown으로 보존합니다. unsupported artifact/subject/media, 누락된 graph/version, parse/hash/read 오류는 **삭제 시작 자체를 중단**합니다.

candidate는 root/parent를 child보다 먼저 삭제합니다. 매 삭제 직전 versions + 전체 remaining graph + HEAD를 다시 읽어 변동을 검출하며, retained/foreign/unknown 보호 closure 및 남은 모든 parent references가 있는 child는 삭제하지 않습니다. REST DELETE는 그 version ID 하나만 대상으로 하며 arbitrary untagged prune이 아닙니다. 각 삭제의 실제 204 응답과 이후 inventory의 absence를 확인한 것만 `deleted`로 셉니다. 중간 child 실패가 남긴 orphan은 keep/deferred이고 다음 실행에서 journal만으로 ownership을 증명하지 않습니다. graph와 inventory 사이/DELETE 사이 완전 원자 compare-and-delete API는 없으므로 외부 mutation은 fail-closed 검사로 최대한 차단하지만 완전 race-free/모든 versions strict finite/완전 rollback은 보장하지 않습니다.

각 실행은 최대20 DELETE, 240초 API 예산, request10초, retries=0, inventory2000/graph256 nodes/depth32/response4MiB 상한입니다. GitHub job timeout도6분입니다. `status`, static `reason`, actual confirmed `deleted`, 측정된 `versions_remaining`(조회 실패는 null), protected/unknown counts와 nonsecret root/verified-child 계획·attempted/confirmed digest를 summary 및14일 artifact에 남깁니다. delete 여부를 추측하지 않습니다. 권한/공개 다운로드 제한/mutation/보호 참조/시간 예산은 deferred/error이며 owner followup이 필요합니다.

`GITHUB_TOKEN packages:write`만으로 package DELETE/admin 권한이 자동 보장되는 것은 아닙니다. owner가 **repo-linked package settings -> Manage Actions access에서 이 repository의 Admin 권한**을 확인해야 합니다. metadata가 admin=false면 즉시 차단하며, permission field가 없는 API 응답은 admin 증거가 아닙니다. 실제 confirmed DELETE 성공만 권한 확인 결과로 보고하고 401/403은 `package_actions_access_required`, 공개 다운로드 제한/API 삭제 거부는 static rejection code로 보고합니다. 새 PAT/광범위 토큰/공개 다운로드 제한 우회는 하지 않습니다. 정상 완료 시 최근10 root(+보호 graph) 정책이고 unknown/foreign/orphan/공개 제한 항목이 있어 registry 전체가 엄밀한10 versions로 줄어드는 정책은 아닙니다.

장기 offline 서버의 local current/rollback은 registry 보존기간과 무관하게 삭제하지 않습니다. 다만 registry retention 밖의 digest는 서버 disk 손실/관리자 prune 후 **재pull 불가능**할 수 있습니다. registry와 local retention은 공간의 엄밀한 byte 상한이 아니며 보호/shared/unknown/실패 항목이 남을 수 있습니다. 이전 digest를 operator가 강제로 지우면 rollback 보장은 사라집니다.

## 운영 명령 / 한계

```bash
# root owner의 explicit 최신 main/digest 재배포 (Actions wrapper에는 force 허용 안 함)
sudo python3 /srv/selfhost/apps/my-mastra/deploy.py --sha FULL_MAIN_SHA \
  --digest ghcr.io/spread-one/my-mastra@sha256:FULL_DIGEST_HEX --force
# root owner의 수동 이전 성공 복구 (자동 main workflow를 먼저 중지/승인 gate로 보류)
sudo python3 /srv/selfhost/apps/my-mastra/deploy.py --rollback
# secret 없는 상태 확인
sudo cat /srv/selfhost/apps/my-mastra/state/deployed.json
sudo cat /srv/selfhost/apps/my-mastra/state/status.json
sudo docker ps --filter label=com.docker.compose.project=my-mastra
# bot 자체만 멈춤: in-flight deploy가 없는 상태에서
sudo docker compose --project-name my-mastra --project-directory /srv/selfhost/apps/my-mastra \
  --env-file /srv/selfhost/apps/my-mastra/image.env -f /srv/selfhost/apps/my-mastra/compose.yaml stop bot
```

자동 배포 보류/중지는 owner가 GitHub workflow disable 또는 environment 승인 gate로 처리합니다. 이미 시작된 remote deploy는 취소 이후에도 rollback/commit을 마칠 수 있으므로 실제 상태를 확인합니다. `.env`/snapshot cat, full compose config/inspect, SDK debug payload/credential logs를 공유하지 마세요. SSH key/hostkey check 우회는 지원하지 않습니다.

WSL/Windows sleep·재부팅·WSL/Docker 자동 시작/always-on은 별도 운영 승인 사항입니다. Docker `unless-stopped`는 daemon이 실제 실행됐을 때만 기존 container를 재시작합니다. 이 구현은 Windows/OS/SSH/Tailscale 설정을 원격 변경하지 않았으며 offline 중 Actions deploy는 실패합니다. polling이 없으므로 온라인 복귀 후 owner가 최신 main workflow를 rerun하거나 명시적 배포를 해야 합니다. Docker unhealthy만으로 자동 restart되지 않으므로 장애 복구도 Actions rerun/owner 확인이 필요합니다.

## 검증

`npm run typecheck`, `npm test`, `npm run build`, CLI/Slack help, `npm run test:deployment`를 각각60초 이하로 검증합니다. TS는 기존 회귀 + synthetic SDK/file readiness와 subprocess signal/late-failure, Python은 fake Docker/Git/clock, 실제 fake-binary CLI/flock, fixed wrapper/env/argv/auth/remote exit status, retention protected/foreign/referenced/race/failed deploy 계약을 검사합니다. hosted check job은 키 없이 실제 linux/amd64 image를 build하고 smoke하며 push하지 않습니다. main publish는 검증 이후 별도 build/push하고 attestation/index version 누적을 줄이기 위해 `provenance:false`, `sbom:false` single-platform manifest를 사용합니다. OCI source/revision labels와 digest 검증은 유지하며 서명/BuildKit provenance attestation을 제공한다고 주장하지 않습니다. `deploy/smoke.sh`는 **이미 Actions에서 빌드된** image의 synthetic Compose quiet parse 및 nonroot/read-only/tmpfs/help/missing-key/false-health smoke 용도이며 host build를 하지 않습니다. 실제 main image publish/public pull/Tailscale SSH/system bootstrap/Slack E2E/WSL 재기동은 별도 owner 검증입니다.
