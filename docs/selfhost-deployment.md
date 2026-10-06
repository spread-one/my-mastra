# SamKim: GitHub Actions 직접 배포

## 현재 설계 / 실행 경계

```text
PR / main push -> GitHub-hosted check (typecheck/test/build/배포 계약)
                       -> main push ONLY + needs: check
                       -> GHCR full-SHA linux/amd64 build/publish + OIDC Cosign digest signature
                       -> deploy job (contents:read only, selfhost environment)
                       -> ephemeral tag:samkim-ci Tailscale OAuth node
                       -> native tailscale ssh samkim-deploy@DEPLOY_HOST
                       -> sudo -n /usr/local/sbin/samkim-deploy SHA IMAGE@DIGEST
                       -> root-trusted pinned Cosign exact identity/issuer verification
                       -> fixed root-owned host script / single bot Compose (1 CPU / 1GiB / 128 pids)
                       -> Slack readiness + stable restart count / rollback
                       -> actual remote exit status -> Actions deploy job result
```

**이미지 빌드는 GitHub-hosted Actions에서만 합니다.** 서버에는 Dockerfile/source checkout/build/npm install/runner가 없습니다. 호스트는 공개 GHCR digest image를 pull하고 bot만 교체합니다. polling/systemd timer는 제거했습니다. 공개 PR/fork에는 publish/deploy/OAuth 연결이 실행되지 않으며 persistent self-hosted runner, public inbound ports, 일반 sshd/SSH key/hostkey bypass도 없습니다. 원격 인증은 Tailscale node identity, ACL/SSH policy, coordination server가 배포하는 SSH host key를 사용합니다.

권한: 전역 `contents: read`; main publish job만 `packages: write` + `id-token: write`; check/deploy에는 OIDC 쓰기 권한이 없습니다. `selfhost` environment는 owner가 승인 정책을 관리합니다. SHA 태그는 이름 규약이지 불변성 보장이 아닙니다. publish가 immutable digest에 GitHub OIDC keyless 서명하고 서버가 정확한 identity/issuer로 검증합니다. source/revision OCI labels는 **metadata이지 cryptographic build provenance가 아닙니다**. 별도 provenance attestation은 채택하지 않습니다: 현재 필요한 경계는 main workflow가 해당 digest를 서명했다는 인증이며 subject/source/workflow/ref predicate를 인증하는 build provenance는 별도 설계가 필요합니다. 신뢰된 main workflow/저장소·Actions 자체 탈취, 악성 main 코드/빌드 dependency까지 막는다고 주장하지 않습니다. branch protection/Actions 리뷰는 여전히 필요합니다.

**작업 입력 기준 서버 bot은 healthy이나 자원 제한이 없고 unsigned입니다.** 현재 SHA `4314046`, digest `sha256:08457075d1d146c7ec9e008167d9f5aa95c7b8c20c5924fddd9efa00975fd8fa`. worker가 서버에 접속/확인/변경한 결과가 아닙니다. 저장소 merge만으로 root-only `/opt/samkim` 템플릿은 갱신되지 않습니다. 이 PR은 구현/fixture/hosted smoke와 운영 적용안까지이며 main merge/publish/deploy 수동 실행/서버 변경을 수행하지 않습니다. app 키는 host-only이며 읽거나 전송하지 않습니다. 아래 **unsigned 전환 차단**을 해소하고 owner rollout 승인을 받기 전 적용하지 마세요.

## Keyless signature / verifier trust

- 고정 issuer: `https://token.actions.githubusercontent.com`
- **정확한** certificate identity: `https://github.com/spread-one/my-mastra/.github/workflows/ci.yml@refs/heads/main`
- regex/branch-wide allowlist/env override/key fallback/ignore-tlog/ignore-SCT/unsigned exception이 없습니다. Cosign 기본 signature/certificate/SCT/Rekor 검증 및 digest claims를 유지하고 verified payload의 repository/digest도 검사합니다. 잘못된 issuer/identity/workflow/ref/digest, unsigned, missing/untrusted verifier, nonzero/timeout/network 실패는 candidate runtime/env/journal/container 변경 전에 거절합니다. 이전 성공 state를 인증 근거로 대신 쓰지 않습니다.
- `/opt/samkim/cosign`은 root-owned regular file 0700, 모든 parent는 root-owned/non-group-other-writable **directory**여야 합니다(symlink 거부). invocation마다 최초 digest 검증 전에 고정 SHA256과 `version --json`의 `gitVersion`을 검사합니다. fixed absolute executable만 호출하며 verifier env는 임시 HOME/DOCKER_CONFIG와 fixed PATH/LANG만 허용합니다. root-owned code 자체를 공격자가 바꿀 수 있으면 이 경계는 무효입니다.
- version 호출 최대5초, verify 최대20초, 전체 deploy deadline 내로 제한합니다. stdout/stderr/certificate/errors를 operator/Actions에 전달하지 않고 authored static failure code만 출력합니다. 공개 GHCR anonymous signature pull + Sigstore trust/TUF/Rekor 통신이 필요하며 outage도 fail-closed입니다. registry signature를 지우거나 private으로 바꾸면 local image가 있어도 recovery가 차단될 수 있습니다.

### Immutable pins / 설치 및 업그레이드 출처

Cosign **v2.6.5**, official [release](https://github.com/sigstore/cosign/releases/tag/v2.6.5) (2026-08-06), linux-amd64 [asset](https://github.com/sigstore/cosign/releases/download/v2.6.5/cosign-linux-amd64):

```text
SHA256 c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644
release gitCommit 3e82f50a2839855693aacf7b3d0e7e2f30774cb4
```

`deploy/cosign_download.py`에 URL/version/hash를 고정하며 **hash 확인 이전 실행하지 않습니다**. official release API asset.digest, `cosign_checksums.txt`, 실제 다운로드 bytes를 대조했습니다. release의 `cosign-linux-amd64.sig`를 tag `v2.6.5`의 `release/release-cosign.pub`(release asset public key와도 일치)로 local Linux container에서 offline 공개키 검증했습니다. 이 추가 확인은 공개키 signature의 무결성 검사이며 keyless release identity/tlog verification이라고 주장하지 않습니다(offline blob 검사에서만 tlog를 생략; production image verify에는 절대 사용하지 않음). checksum과 public key는 upstream/리뷰한 pin을 trust anchor로 쓰며 공급자 자체 탈취까지 방어하지 않습니다.

[GHSA-whqx-f9j3-ch6m](https://github.com/sigstore/cosign/security/advisories/GHSA-whqx-f9j3-ch6m) Rekor 검증 문제(<=2.6.1, patched2.6.2)와 [GHSA-fx35-mq7g-6g98](https://github.com/sigstore/cosign/security/advisories/GHSA-fx35-mq7g-6g98) legacy blob bundle bypass(<=2.6.4, patched2.6.5)를 확인하여 v2.4.3 대신 승인된 v2.6.5를 선택했습니다. 후자는 image verification 영향은 없지만 bootstrap 검증에도 패치된 도구를 사용합니다.

`ci.yml` action pins는 각 official upstream의 `git ls-remote refs/tags/<version>`로 확인했습니다:

| Action | SHA | 출처 |
| --- | --- | --- |
| actions/checkout | `11d5960a326750d5838078e36cf38b85af677262` | official v4, backport fixes #2524 (v4.3.1 tag SHA와 다름) |
| actions/setup-node | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| docker/setup-buildx-action | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` | v3.12.0 |
| docker/login-action | `c94ce9fb468520275223c153574b00df6fe4bcc9` | v3.7.0 |
| docker/build-push-action | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` | v6.19.2 |

기존 Tailscale action/version은 변경하지 않습니다. 업그레이드는 owner가 advisory/release/source/checksum/signature를 새로 검토하고 helper 및 deployer의 version/hash를 **동시에** PR로 변경하여 fixtures/hosted CI를 재검증한 후 승인합니다. auto-update/PATH 발견/latest fallback은 없습니다. 서버 installer와 CI publish는 같은 pinned bytes를 사용합니다. `--stage`는 root ownership을 증명하지 않는 templates-only fixture이며 verifier 다운로드/실행을 하지 않습니다. 실제 Linux root 설치는 별도 owner 승인 검증입니다.

## Unsigned current 전환 — blocking operational gate

이 PR을 merge한다고 현재 unsigned 이미지에 서명이 생기거나 root 템플릿이 바뀌지 않습니다. 새 deployer는 unsigned current를 rollback anchor로 사용하는 transaction을 **runtime/env/journal 변경 전에 차단**합니다. 서명이 없는 현재를 허용하는 예외/옵션, state 삭제를 통한 초기 배포/stop, 임의 과거 digest 재서명 경로를 제공하지 않습니다.

승인된 방향은 **owner-gated signed rollback anchor bootstrap**입니다. main이 사용자와 merge 전 자동배포/environment gate 및 별도 rollout 승인을 조율해야 합니다. worker는 GitHub 운영 설정도 변경하지 않습니다. 안전한 자동 recovery 가능한 signed anchor가 없으면 **실제 최초 전환은 이 PR만으로 실행 불가능**합니다. 다음은 별도 owner 운영안이지 이 PR에서 완료된 절차가 아닙니다:

1. 자동 delivery를 gate로 보류하고 모든 in-flight deploy를 완료/확인. 현재 실행중 unsigned healthy bot은 그대로 유지. 검토된 이전 root 템플릿, local current image, private env/state/snapshot 및 secret 없는 상태 증거를 백업하고 관리자 수동 복구 경로를 검증.
2. 승인 후 정상 trusted main publication으로 signed candidate와 보존할 signed anchor를 확보. PR check 성공은 publication/서명 성공이 아니며 과거 unsigned digest를 임의로 서명하지 않음. registry image+signature graph/public anonymous verify, local image/env, readiness와 자원 적정성 확인이 필요.
3. **signed healthy anchor를 최초로 만들려면 unsigned 상태와 단절되는 owner-only 전환이 필요**합니다. 그 설치/활성화 및 구버전 템플릿·실행중 image/state 백업을 이용한 수동 복구의 구체적 절차/다운타임 승인은 main이 사용자와 별도로 합의해야 합니다. 이 PR에는 state 조작/bootstrap CLI가 없고, unsigned current를 자동 recovery할 수 있다고 주장하지 않습니다. 합의된 anchor bootstrap 없이는 새 verifier 강제 적용/컨테이너 교체를 실행하지 않습니다.
4. 검증된 signed healthy state/local rollback anchor가 확보된 후에만 새 root 템플릿/verifier를 같은 lock으로 설치하고 별도 승인된 explicit deployment로 제한/서명/readiness/rollback을 확인. unsigned history를 success/verified라고 다시 표시하지 않음. 긴 registry/Sigstore 장애에는 자동 rollback도 차단되므로 owner 수동 incident response가 필요.

## 자원 제한 적정성 / 운영 검증 한계

`cpus=1.0`, `mem_limit=1g`(1073741824 bytes), `pids_limit=128`은 host runaway 영향 완화의 초기 후보입니다. LLM 호출은 외부 I/O 중심이지만 동시 Slack 이벤트/웹 도구/Node GC/TLS/thread 수 부하는 아직 측정하지 않았습니다. CPU throttling으로 응답 지연, memory OOM kill/restart, PID exhaustion이 생길 수 있고 제한이 보안 취약점/공유 host 전체 자원을 완전히 격리하지는 않습니다. 기존 tmpfs 64m/1m도 memory accounting에 영향을 줍니다.

hosted smoke는 실제 Compose run HostConfig 수치를 확인하고 deploy readiness도 세 수치를 검사하지만 실제 서버 kernel/cgroup 지원과 지속부하 적정성을 증명하지 않습니다. **운영 승인 이후** owner가 bot만 대상으로 secret-free HostConfig, memory/CPU/pids 사용률, OOMKilled/restart count, cgroup CPU throttling, Slack readiness/응답 지연 및 동시부하를 관찰합니다. full env/config/inspect/log를 공개하지 않습니다. 변경값은 관찰 후 별도 승인 PR/installer/recreate로 조정하며 자동 env override는 없습니다. 저장소 merge/installer만으로 existing container resource limits는 바뀌지 않고 승인된 recreate가 필요합니다.

## 인증 준비 — owner 작업 (worker는 원격 변경하지 않음)

1. 기존 서버는 Tailscale native SSH (`RunSSH=true`)를 사용합니다. 일반 sshd 설치/활성화, SSH private key/authorized_keys, 임의 hostkey 우회를 추가하지 않습니다.
2. CI source는 `tag:samkim-ci`, target은 `tag:samkim-server`. **tagged -> SSH는 target도 tagged여야 합니다.** owner가 tailnet policy를 먼저 검토하고 기존 관리자 Mac -> target SSH 권한을 명시적으로 보존/검증한 뒤 target tag를 변경해야 합니다. `autogroup:self`는 서버가 tagged가 되면 기존 방식으로 매칭되지 않을 수 있습니다. 접근 복구 경로/관리자 세션 없이 tagging하지 마세요.
3. `deploy/tailnet-policy.example.hujson`은 추가 규칙의 placeholder **fragment**입니다. 기존 policy 전체를 덮지 않습니다. network grants는 CI -> target `tcp:22`만, SSH users는 `samkim-deploy` 하나로 제한합니다. CI에 `root`/`autogroup:nonroot`나 대화형 `check`를 허용하지 않습니다. 기존 broad grants/SSH rules가 추가 권한을 줄 수 있으므로 owner가 함께 audit합니다. administrator rule은 기존 실제 identity/OS user에 맞춰 유지합니다. Tailscale 정책/서버 tag/RunSSH를 worker가 변경하지 않았습니다.
4. OAuth client는 ephemeral tagged node를 만들 수 있는 최소 auth-key scope 및 `tag:samkim-ci`만 부여합니다. CI client에 server tag 적용 권한, tailnet ACL 관리, 광범위 device 관리 권한을 주지 않습니다. 실제 OAuth scope/tag-owner 제약은 owner가 콘솔에서 확인합니다. 이 PR은 official pinned Tailscale action v3/OAuth를 사용하고 memory state/userspace networking/no accepted subnet routes, connect retry 1을 설정합니다. job 마지막에는 bounded logout을 시도합니다.
5. OS 계정 `samkim-deploy`를 owner가 준비합니다. interactive shell은 native SSH의 고정 명령 실행에 필요하지만 **docker group/일반 sudo/root access는 금지**합니다. app dir를 읽거나 수정할 수 없어야 합니다. native Tailscale SSH가 OS user/command access를 제한하며 일반 SSH daemon은 필요하지 않습니다.
6. root가 검토된 템플릿을 설치합니다. `/opt/samkim`과 `.env`/code/Compose/state는 root-owned, app dir 0700/secret files 0600. `/usr/local/sbin/samkim-deploy`는 root-owned 0755, `/etc/sudoers.d/samkim-deploy` root-owned 0440. sudoers는 이 wrapper 하나만 NOPASSWD/NOSETENV, env_reset/secure_path로 허용합니다. installer는 계정/tag/policy를 생성/변경하지 않고, 이미 준비된 전용 계정의 위험 그룹을 거부합니다. 다른 sudoers/그룹 멤버십까지 owner가 audit해야 합니다.

Wrapper는 **정확히 SHA 40 lowercase hex + ghcr.io/spread-one/my-mastra@sha256:64 lowercase hex 두 argv만** 허용합니다. `--force`, `--rollback`, APP_DIR/repo/Docker/path/command overrides, 공백/셸문자/추가 argv는 거부합니다. shell range는 ASCII locale로 검증하고 `env -i` + fixed PATH/absolute binaries + Python `-I`로 APP_DIR/PYTHONPATH/GIT/DOCKER/COMPOSE/environment 주입을 차단합니다. root operator의 직접 CLI/rollback과 CI의 sudo wrapper 경계를 구분합니다. wrapper는 cwd도 `/`로 고정하고 host script는 Docker/Git을 `/usr/bin/docker`, `/usr/bin/git` 절대 경로로만 실행합니다. installer는 실제 trusted binaries와 대상의 모든 parent(`/`, `/opt` 포함)가 root-owned/non-group-other-writable인지 검증하며 symlink 경로도 거부합니다. 불일치 시 부모 권한을 자동 변경하지 않고 거부합니다. 일반 사용자 소유 공유 `/srv/selfhost`/`apps`는 그대로 두고 root-trusted app만 `/opt/samkim`에 분리합니다. 공유 부모 chown, 검사 완화, symlink 우회는 하지 않습니다. root script/Compose가 user-writable이면 이 경계가 무너지므로 설치/업데이트 권한을 지켜야 합니다.

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
sudo chown root:root /opt/samkim/.env
sudo chmod 600 /opt/samkim/.env
# sudoers 구문/실제 허용 명령 확인 (비밀번호/키를 출력하지 않음)
sudo visudo -cf /etc/sudoers.d/samkim-deploy
sudo -l -U samkim-deploy
```

installer는 root 코드/Compose/고정 wrapper/단일 sudoers 및 checksum/version 검증된 `/opt/samkim/cosign`(root:root 0700)을 설치하며 env/state/계정/tailnet/서비스를 덮거나 앱을 시작하지 않습니다. installer의 `APP_DIR`는 unset/빈 값 또는 정확히 `/opt/samkim`만 허용하며 다른 경로(이전 경로 포함)는 거부합니다. root operator의 직접 Python CLI는 private 절대 경로 override를 지원하지만 CI wrapper의 `env -i`는 이를 제거해 고정 경로만 사용합니다. `--stage ABSOLUTE_DIRECTORY`는 로컬 fixture 설치용이며 실제 account/sudoers 적용이 아닙니다. `/opt/samkim` 서버 bootstrap/키 전달/기존 앱 처리와 실제 배포 검증은 main owner가 별도로 수행하며 이 경로 변경 PR은 원격 운영 상태를 변경하지 않습니다. 업데이트 전 owner가 자동 배포를 승인 gate로 보류하고 이미 시작/대기 중인 wrapper/Python 프로세스까지 모두 종료/완료됐음을 확인해야 합니다(기존 코드가 lock 전에 로드될 수 있어 flock만으로 구버전 실행을 폐기하지 못함). installer는 동일 persistent `deploy.lock`을 nonblocking으로 잡고 pending deployment가 있으면 거부합니다. 모든 destination/trust/다운로드 검증을 먼저 완료하고 이전 bytes/mode를 private `install-backup/`에 보존합니다. `install-pending.json` marker 뒤 fsync + atomic replace로 각 파일을 설치합니다. 다중 파일 전체가 단일 원자 rename은 아닙니다: 정상 오류는 전체 이전 파일을 복원하고, kill/전원실패는 marker/backup을 남겨 새 deployer가 어떤 배포도 거부합니다. owner가 gate/프로세스 정지 및 동일 lock 아래 journal에 나열된 고정 destination을 검토하고 backup bytes/mode를 복원(이전에 없던 파일은 제거), 검증/fsync한 뒤에만 marker를 제거합니다. 성공 backup도 다음 upgrade 전에 owner가 검토하여 안전하게 별도 보관/제거해야 합니다. env/state는 backup 대상이 아니므로 별도 private 백업으로 보호합니다. 구버전 템플릿 복원은 수동 owner recovery이지 unsigned signature 우회 옵션이 아닙니다. native SSH 배포 재검증/서비스 recreate는 별도 승인이 필요합니다. 이전 제출본 timer는 서버에 설치하지 않았습니다. 혹시 별도로 설치된 환경이면 owner가 먼저 disable/stop/remove하고 중복 운영하지 않아야 합니다.

`.env`는 source하지 않습니다. 허용 키는 `DEEPSEEK_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DEEPSEEK_MODEL`, `EXA_API_KEY`; `KEY=value` 각 한 줄, 빈 줄/# 주석과 단순 enclosing quotes는 허용합니다. export/중복/interpolation/내부 whitespace/control/dollar/backtick/backslash/quote/placeholder는 거부합니다. 실제 키 원문은 로그에 쓰지 않습니다. root-only env snapshot은 **키 사본**이므로 접근/백업도 보호합니다. privileged Docker/root operator는 container env를 읽을 수 있는 신뢰 경계입니다. `.dockerignore` allowlist가 credentials/env/git/node_modules/host state를 image context에서 제외합니다. secret buildargs/cache upload/image layer는 없습니다.

## 배포 transaction / readiness / 상태

- Actions가 publish 출력의 explicit SHA/digest를 전송합니다. 서버는 후보가 현재 public main HEAD인지 시작 때, pull/labels 검사 후 activation 전에, readiness 뒤 commit 전에 재확인합니다. old workflow 재실행으로 main이 뒤로 돌아가지 않습니다. 외부 Git ref와 로컬 교체의 원자성이 없으므로 마지막 검사 직후 ref 변경은 다음 main workflow가 처리합니다. 서버의 폴링 보정은 없습니다.
- 동일 healthy SHA **및 digest**이라도 후보와 current의 signature를 먼저 검증합니다. resource HostConfig까지 성공 상태를 확인한 경우에만 unchanged exit 0입니다. shared nonblocking flock은 busy 시 exit 1입니다. 후보 이미지 없거나 key/label/digest/platform/네트워크 오류는 기존 봇/state를 보존합니다. publish와 deploy 결과는 별개이며 publish만 성공한 것은 배포 성공이 아닙니다.
- fixed digest-pinned Compose로 `up -d --no-deps --force-recreate --pull never bot`만 실행합니다. 단일 bot 교체 downtime이 있을 수 있습니다. read-only/nonroot/tini+init/tmpfs/cap drop/no-new-privileges/unless-stopped/no published ports/log rotation을 유지합니다. `cpus: 1.0`, `mem_limit: 1g`, `pids_limit: 128`을 service-level Compose에 추가합니다(초기 후보; 아래 관찰 한계 참고). 다른 앱 down/prune/reset/daemon restart/build는 없습니다.
- Slack start 완료 + SDK hello connected + 현재 `websocket.isActive()`가 준비 증거입니다. 2초마다 secret 없는 tmpfs `{ready,time}`를 atomic 갱신; stale(10초)/close/reconnect/stop은 unhealthy. running/healthy + pinned image + RestartCount=0 + HostConfig `NanoCpus=1000000000`, `Memory=1073741824`, `PidsLimit=128`을 세 번/최소10초 안정화(약65초 제한)한 뒤만 state commit합니다. process alive/start 로그만으로 성공하지 않습니다.
- candidate와 이전 healthy rollback anchor 모두 활성화 전 strict signature 검증을 통과해야 합니다. old local image metadata/env snapshot도 미리 확인합니다. rollback/activate/recovery/committed-journal/unchanged 경로에도 검증을 적용하며 invocation 내 이미 검증한 digest만 cache합니다. verifier/네트워크가 복구 시 사용 불가능하면 journal과 이전 성공 state를 유지한 채 unconfirmed로 차단합니다. 실패 시 **서명된** 이전 healthy digest와 당시 env snapshot을 복구하고 동일 readiness 검사를 합니다. 최초 실패는 bot만 stop/`failed_initial_no_rollback`; rollback 불확실이면 journal과 `failed_rollback_unconfirmed`. `deployed.json`은 성공 시만 atomic commit하며 이전 journal이 더 최신 성공 state를 덮지 않습니다. hard kill 후 복구는 **다음 Actions/owner invocation** 때 수행하며 timer가 없습니다.
- host commands/deployment/recovery/SSH/job은 각각 bounded입니다. SIGTERM은 정상 rollback을 시도하고 timeout kill 후 status는 unconfirmed일 수 있습니다. SSH timeout/lost connection은 서버가 실제로 실패했다는 증거가 아니라 **결과 미확인**이므로 Actions는 failure로 표시하고 owner가 확인합니다.
- `state/deployed.json`은 마지막 healthy SHA/digest/snapshot/previous/history이고 `status.json`은 secret 없는 결과입니다. `image.env`는 현재 activation digest, `.env.runtime`은 현재 activation env, `pending.json`은 journal, `env-*`는 보호된 snapshot, `deploy.lock`은 삭제하면 안 되는 persistent flock inode입니다. 마지막 successful state가 지금 살아 있는 container라는 보장은 없으므로 status/container health를 함께 확인합니다.
- health는 Socket 연결이지 DeepSeek 키의 공급자 유효성/Slack scopes/model/web tools 실제 응답 E2E가 아닙니다. owner가 live 답변 검증을 해야 합니다. SDK payload/error는 고정 code로만 로그하며 executable late failure도 bounded shutdown/exit 1로 처리합니다. 라이브러리 import에 전역 handler를 설치하지 않습니다.

## 이미지 retention

Local cleanup은 successful/unchanged-healthy 배포 뒤 동일 flock 안에서 **현재 + rollback을 항상 보호하고 최근 성공 digest 3개**를 유지합니다. 보호 record가 history 밖이면 세 개보다 많을 수 있습니다. source/revision/amd64/digest/모든 tag가 앱 전용임을 검증한 과거 image id만 대상으로 합니다. 다른 repository alias/unknown provenance/모든 running·stopped container가 참조한 image는 보존합니다. state/image metadata와 container references를 삭제 직전에 재검사하고 **non-force `docker image rm ID`**만 사용합니다. race/ref 충돌/권한/시간 초과는 `retention_deferred`이지 deployment 실패가 아닙니다. 실패 배포/rollback 중에는 GC하지 않습니다. global image/system/builder prune은 없습니다. 현재/이전/최근 성공 env snapshots도 보호합니다.

Registry는 별도 `.github/workflows/registry-retention.yml`의 daily schedule / owner `workflow_dispatch` main-only job에서 자동 정리합니다. 해당 job만 `packages:write`이며 delivery workflow에 needs로 연결되지 않아 cleanup 실패가 publish/remote deploy 결과를 바꾸지 않습니다. publish와 cleanup은 **동일 `samkim-ghcr-mutation` concurrency group**을 사용합니다. 이 앱 package의 모든 추가 workflow/publisher도 같은 lock 및 immutable full-SHA tag 계약을 따라야 합니다. GitHub concurrency는 외부/수동 publication까지 잠그지 못합니다.

`deploy/registry_cleanup.py`는 package/repo/API를 하드코드 allowlist로 고정하고 args로 arbitrary package를 삭제하지 않습니다. public/repository linkage를 확인하고 anonymous OCI manifest/config SHA256 검증으로 graph를 읽습니다. 최신 main HEAD, **최근10 app-owned full-SHA roots + 24h grace + 현재 main root**의 recursive closure를 보호합니다. foreign/multiple/unknown tags와 unknown orphan roots의 모든 dependencies도 보호합니다. index의 single linux/amd64 config source/revision이 SHA와 일치해야 app-owned입니다. legacy attestation의 `os=unknown` config는 안전한 ownership 증명을 하지 않고 전체 root/child closure를 foreign/unknown으로 보존합니다. Cosign v2의 `sha256-<subject digest>.sig` 및 legacy `.att` tag는 foreign root로 보존하고 subject -> children 전체 closure까지 보호합니다. 이 보수적 정책은 오래된 서명된 image도 GC하지 않으므로 registry byte/10 versions 상한을 보장하지 않습니다. signature subject가 inventory에 없거나 cycle이면 전체 삭제를 중단합니다. OCI referrer의 unsupported artifact/subject/media도 **전체 삭제를 중단**합니다(미지원 형식을 모른 척 삭제하지 않음). 누락된 graph/version, parse/hash/read 오류도 동일합니다.

candidate는 root/parent를 child보다 먼저 삭제합니다. 매 삭제 직전 versions + 전체 remaining graph + HEAD를 다시 읽어 변동을 검출하며, retained/foreign/unknown 보호 closure 및 남은 모든 parent references가 있는 child는 삭제하지 않습니다. REST DELETE는 그 version ID 하나만 대상으로 하며 arbitrary untagged prune이 아닙니다. 각 삭제의 실제 204 응답과 이후 inventory의 absence를 확인한 것만 `deleted`로 셉니다. 중간 child 실패가 남긴 orphan은 keep/deferred이고 다음 실행에서 journal만으로 ownership을 증명하지 않습니다. graph와 inventory 사이/DELETE 사이 완전 원자 compare-and-delete API는 없으므로 외부 mutation은 fail-closed 검사로 최대한 차단하지만 완전 race-free/모든 versions strict finite/완전 rollback은 보장하지 않습니다.

각 실행은 최대20 DELETE, 240초 API 예산, request10초, retries=0, inventory2000/graph256 nodes/depth32/response4MiB 상한입니다. GitHub job timeout도6분입니다. `status`, static `reason`, actual confirmed `deleted`, 측정된 `versions_remaining`(조회 실패는 null), protected/unknown counts와 nonsecret root/verified-child 계획·attempted/confirmed digest를 summary 및14일 artifact에 남깁니다. delete 여부를 추측하지 않습니다. 권한/공개 다운로드 제한/mutation/보호 참조/시간 예산은 deferred/error이며 owner followup이 필요합니다.

`GITHUB_TOKEN packages:write`만으로 package DELETE/admin 권한이 자동 보장되는 것은 아닙니다. owner가 **repo-linked package settings -> Manage Actions access에서 이 repository의 Admin 권한**을 확인해야 합니다. metadata가 admin=false면 즉시 차단하며, permission field가 없는 API 응답은 admin 증거가 아닙니다. 실제 confirmed DELETE 성공만 권한 확인 결과로 보고하고 401/403은 `package_actions_access_required`, 공개 다운로드 제한/API 삭제 거부는 static rejection code로 보고합니다. 새 PAT/광범위 토큰/공개 다운로드 제한 우회는 하지 않습니다. 정상 완료 시 최근10 root(+보호 graph) 정책이고 unknown/foreign/orphan/공개 제한 항목이 있어 registry 전체가 엄밀한10 versions로 줄어드는 정책은 아닙니다.

장기 offline 서버의 local current/rollback은 registry 보존기간과 무관하게 삭제하지 않습니다. 다만 registry retention 밖의 digest는 서버 disk 손실/관리자 prune 후 **재pull 불가능**할 수 있습니다. local image가 남아도 remote signature graph/TUF/Rekor 검증 자원이 없으면 rollback은 fail-closed로 불가능할 수 있습니다. local Docker retention은 서명을 cryptographic evidence로 보관하지 않으며 unsigned rollback을 허용하지 않습니다. registry와 local retention은 공간의 엄밀한 byte 상한이 아니며 보호/shared/unknown/실패 항목이 남을 수 있습니다. 이전 digest를 operator가 강제로 지우면 rollback 보장은 사라집니다.

## 운영 명령 / 한계

```bash
# root owner의 explicit 최신 main/digest 재배포 (Actions wrapper에는 force 허용 안 함)
sudo python3 /opt/samkim/deploy.py --sha FULL_MAIN_SHA \
  --digest ghcr.io/spread-one/my-mastra@sha256:FULL_DIGEST_HEX --force
# root owner의 수동 이전 성공 복구 (자동 main workflow를 먼저 중지/승인 gate로 보류)
sudo python3 /opt/samkim/deploy.py --rollback
# secret 없는 상태 확인
sudo cat /opt/samkim/state/deployed.json
sudo cat /opt/samkim/state/status.json
sudo docker ps --filter label=com.docker.compose.project=my-mastra
# bot 자체만 멈춤: in-flight deploy가 없는 상태에서
sudo docker compose --project-name my-mastra --project-directory /opt/samkim \
  --env-file /opt/samkim/image.env -f /opt/samkim/compose.yaml stop bot
```

자동 배포 보류/중지는 owner가 GitHub workflow disable 또는 environment 승인 gate로 처리합니다. 이미 시작된 remote deploy는 취소 이후에도 rollback/commit을 마칠 수 있으므로 실제 상태를 확인합니다. `.env`/snapshot cat, full compose config/inspect, SDK debug payload/credential logs를 공유하지 마세요. SSH key/hostkey check 우회는 지원하지 않습니다.

WSL/Windows sleep·재부팅·WSL/Docker 자동 시작/always-on은 별도 운영 승인 사항입니다. Docker `unless-stopped`는 daemon이 실제 실행됐을 때만 기존 container를 재시작합니다. 이 구현은 Windows/OS/SSH/Tailscale 설정을 원격 변경하지 않았으며 offline 중 Actions deploy는 실패합니다. polling이 없으므로 온라인 복귀 후 owner가 최신 main workflow를 rerun하거나 명시적 배포를 해야 합니다. Docker unhealthy만으로 자동 restart되지 않으므로 장애 복구도 Actions rerun/owner 확인이 필요합니다.

## 검증

`npm run typecheck`, `npm test`, `npm run build`, CLI/Slack help, `npm run test:deployment`를 각각60초 이하로 검증합니다. TS는 기존 회귀 + synthetic SDK/file readiness와 subprocess signal/late-failure, Python은 fake Docker/Git/clock, 실제 fake-binary CLI/flock, fixed wrapper/env/argv/auth/remote exit status, retention protected/foreign/referenced/race/failed deploy 계약을 검사합니다. hosted check job은 키 없이 실제 linux/amd64 image를 build하고 smoke하며 push하지 않습니다. main publish는 검증 이후 별도 build/push하고 attestation/index version 누적을 줄이기 위해 `provenance:false`, `sbom:false` single-platform manifest를 사용합니다. OCI source/revision labels와 digest metadata 검증은 유지하며 keyless digest signature를 추가합니다. BuildKit provenance attestation은 제공하지 않습니다. PR check는 OIDC signing을 실행하지 않고 mock/합성 verifier responses는 실제 인증서/암호 검증을 증명하지 않습니다. `deploy/smoke.sh`는 **이미 Actions에서 빌드된** image의 synthetic Compose parse + 실제 Compose run HostConfig 자원 제한 및 nonroot/read-only/tmpfs/help/missing-key/false-health smoke 용도이며 host build를 하지 않습니다. 합성 env만 사용하고 network-none test command container만 생성/삭제합니다. 이것은 실제 bot 부하/Slack/서버 cgroup 테스트가 아닙니다. 실제 main image publish/public pull/Tailscale SSH/system bootstrap/Slack E2E/WSL 재기동은 별도 owner 검증입니다.
