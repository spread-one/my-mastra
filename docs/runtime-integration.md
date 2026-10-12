# Slack/CLI runtime integration

## 실제 등록과 신뢰된 호출

- 라이브러리 `createWebTools()` / 기본 `createMastra()`는 기존 `web_fetch`, `web_search` 계약을 유지한다. typed host-only `extraTools`로 등록을 확장한다. import는 env/키/모델/네트워크/SQLite를 초기화하지 않는다. factory의 기존 telemetry-off/no-logger 정책을 유지한다.
- CLI `createChat`은 네 웹 도구(검색/fetch/read_more/find_in_content)로 opt-in한다. 프로세스/세션 UUID `cli:` scope를 재호출에 유지하며 다른 createChat 세션과 격리한다. Slack 코드/키를 실행에 요구하지 않으며 가짜 Slack actor를 WeakMaps에 넣지 않는다.
- production Slack은 네 웹 도구와 `slack_search`, `slack_read_channel`, `slack_read_thread`, `slack_read_attachment`, `slack_analyze_image`를 실제로 등록한다. model prompt와 plan 레이블은 그 계약을 설명한다. 요약은 도구 없는 별도 호출이다.
- Chat의 기존 `(messages, signal, progress?)` 뒤 optional trusted metadata가 추가된다. handler가 인증된 **원래 event**에서 team/user/channel/root/requestId/action_token을 얻고 admission signal을 전달한다. handler가 invocation RequestContext에 identity+action token+signal을 private WeakMap으로 bind한다. 자동 authoritative thread 조회도 이 객체와 silent base read transport를 사용하여 페이지마다 live origin 권한을 검사한다. model adapter는 그 **동일한 객체**를 `agent.stream`에 전달한다. 공개 entries는 web snapshot scope의 네 primitive 필드뿐이다. 텍스트/검색 hints/file 후보/public entries는 Slack authority가 아니다.
- action token/설정 키/private download URL은 messages/history/logs/plan에 전달하지 않는다. 입력과 canonical 출력은 redaction하고, Slack 도구 결과가 설정 키/action token/private URL을 반사하면 static blocked result로 거부한다. raw SDK/provider errors나 파일 경로는 로그하지 않는다. 비직렬화(cycle/BigInt/undefined/throwing toJSON) 결과도 static blocked/unavailable로 처리하고 검사한 inert JSON snapshot만 모델로 전달한다. 임의 비밀을 탐지하는 일반 DLP를 보장하지 않는다.

## Slack 설치 / 지원 실패

Manifest는 `app_mentions:read`, `chat:write`, `im:history`, `channels:history`, `groups:history`, live info/members의 `channels:read`, `groups:read`, `im:read`, `files:read`, 검색 `search:read.public`을 포함한다. 비공개 채널을 쓰지 않으면 groups scopes를 제거할 수 있다. 권한 변경 뒤 owner가 **수동 reinstall/reapprove**하고 bot 초대·실제 conversations API/token type 지원을 확인해야 한다. app token은 여전히 `connections:write`만이다.

`slack_search`는 공식 `assistant.search.context` + authenticated event `action_token`만 사용한다. Slack AI/Real-time Search 지원과 앱 설치 capability, public origin과 봇 scope를 실제 환경에서 확인해야 한다. 토큰 없는 DM/설치 미지원/만료/권한 거부는 명시적 unsupported/access_denied이며 성공한 빈 결과가 아니다. search.all/messages, user OAuth, auto-join, 다른 키나 history scan으로 fallback하지 않는다. 검색 snippets는 파일 grant나 전체 스레드 증거가 아니다.

## 파일 / 이미지

사람의 원래 `file_share`만 subtype 예외다. bot/edits/deletes/hidden/시스템 subtype은 그대로 제외한다. attachment-only DM/멘션도 처리한다. event.files는 최대10개의 valid primitive fileId/messageTs/threadTs와 선택적 name(512)/MIME(200)만 후보로 투영한다. URL/token/raw file record를 전달하지 않으며 후보 JSON도 전체 input/context budget에 포함된다. filename은 비신뢰 data다. authoritative thread는 current text/subtype/candidate consistency와 기존 전체-history/chronology/role/summary 규칙을 유지하며 current는 정확히 한 번만 나타난다. metadata를 실제 읽은 파일 내용처럼 설명하지 않는다. current 전체 envelope와 history를 invocation secrets로 먼저 정제한 후 완전한 오래된 pair를 pruning/budgeting한다. redaction·summary 확장까지 끝낸 전체 JSON을 chat 직전에48KB로 다시 검사하며 root/current를 자르거나 초과 맥락을 모델에 보내지 않는다.

첨부 권한 adapter는 base `createSlackReadClient(app.client)`의 동일 bot credential을 사용한다. silent SDK/timeout10s/no retry/request-interceptor signal을 유지한다. operation-local `scopedSlackClient`의 하나의 15s/32call budget 안에서 live channel/requester/workspace, exact current-channel message→file relation, fresh fixed `files.info`, 다운로드 직전 relation/access 재검증을 수행한다. metadata는 own primitive ID/name/MIME/size/private download URL/mode/external schema로 snapshot한다. bot files.info 자체는 grant가 아니다. hosted 또는 TXT/Markdown/CSV snippet만 지원하고 타 채널 검색으로 파일 접근을 넓히지 않는다. 기존 downloader의 Slack-only URL/public DNS pinning/TLS/redirect/4MiB/10s 정책과 parser/image validators를 그대로 사용한다.

PDF dependency는 **pdfjs-dist 4.10.38**로 고정하며 설치된 `legacy/build/pdf.mjs`를 trusted absolute file URL로 resolve한다. 최대2 child, V8 heap128MiB/5s, 기존 preflight/resource bounds를 유지한다. encrypted/malformed/no-text/unsupported/missing dependency는 명시적 실패다. 모든 PDF를 지원하거나 OCR을 제공하지 않는다. optional `@napi-rs/canvas` 및 플랫폼 native binaries가 lock에 추가된다. native RSS는 V8 heap limit에 포함되지 않으며 Docker memory/pids limits를 병행한다. 현재 lock의 `npm audit --omit=dev`는 기존 Mastra→gray-matter→js-yaml→argparse→sprintf-js 경로의 moderate 5개를 보고한다(그중 sprintf-js advisory; PDF.js 신규 advisory는 보고되지 않음). audit 무결점이나 공급망/native sandbox를 주장하지 않으며 자동 force/major dependency 변경은 하지 않았다.

Vision은 별도의 optional **VISION_API_KEY / VISION_BASE_URL / VISION_MODEL**이다. 모두 빈 값이면 이미지 도구는 `VISION_CONFIG` unavailable이고 다운로드/실행 모델 fallback을 하지 않는다. 일부/unsafe config는 static names-only ConfigError. HTTPS/public endpoint shape를 config에서 검사하고 실제 DNS 전체/public pinned socket은 기존 vision transport가 실행 시 검사한다. configured Slack credential을 Vision key로 쓰지 않는다. endpoint/model/키는 모델 도구 인자로 받지 않는다. inline PNG/JPEG bytes와 질문만 외부 이미지 공급자에 보내므로 사전 데이터 전송/보관 정책 승인이 필요하다. 결과는 **파생 해석**, 원문 OCR/수치 정확성 증거가 아니다.

## 영속 DM과 배포

Slack startup은 `.local/slack-history/history.sqlite`(gitignored, optional local SLACK_HISTORY_DB) real SQLite를 연 다음 admission을 등록한다. startup failure는 handle을 닫는다. configured store unavailable/corrupt/actor inconsistency는 static history-unavailable 안내로 실패 폐쇄하며 missing-context model answer를 만들지 않는다. 채널 history는 항상 Slack이다. DM key는 authenticated team/DM channel/thread로 격리하고 저장된 사용자 author를 현재 actor와 비교한다.

runtime admission/serialization/signal 아래 async get/set/delete를 await한다. 성공한 **최종 Slack delivery 이후만** sanitized canonical Markdown과 완전한 user/assistant pairs를 set한다(7일/128 threads/1MB/thread48KB/12turn). aborted/late model/delivery는 새 쌍을 기록하지 않는다. 일반 실패는 해당 DM key만 delete하며 history 오류/abort/shutdown은 기존 쌍을 보존한다. shutdown은 admission stop→abort/drain→store close이고 persisted history를 지우지 않는다. 비협조적 작업의 signal fence/slot 유지 및 executable bounded exit 정책은 유지한다. 확인된 accepted final delivery 뒤 set 실패에서는 이전 쌍을 보존하고 static “답변은 전송했지만 대화 기록 저장에 실패했습니다…” 안내를 별도5s/최대2개/same-thread1개/no-queue lifecycle로 best effort 전송한다. 모델 실패로 재분류하거나 답변을 retry/fallback하지 않는다. ordinary post/stream-stop의 불확실한 쓰기는 확인된 전달이 아니며 추가 답변/안내를 억제한다. 확인된 전달 후 deadline도 late history commit을 허용하지 않고 shutdown은 부수 안내를 중단한다. Slack send와 SQLite commit은 분산 atomic transaction이 아니므로 둘 사이 crash/commit 실패는 턴 손실/중복을 일으킬 수 있다. exactly-once가 아니다.

Compose는 fixed **my-mastra-history** named volume을 `/var/lib/my-mastra`에 mount하고 fixed DB path `/var/lib/my-mastra/history/history.sqlite`를 공급한다. rootfs read-only/UID1000/caps/resources/tini/digest-signature/rollback을 유지한다. 새 volume은 image-created owner1000/mode700 history directory로 seed하며 기존 host data를 chmod하지 않는다. volume은 replacement/rollback/installer/retention으로 삭제하지 않는다. host env allowlist는 Vision trio만 추가하고 arbitrary extra env/local history override는 허용하지 않는다. backup/권한/기존 unsigned→signed 전환 owner gate는 [selfhost-deployment.md](selfhost-deployment.md)를 따른다.

## 검증과 남은 운영 확인

각 npm test/typecheck/build/test:deployment는60초 이하로 실행한다. 검증은 서로 구분한다:

- **actual SDK + mocks:** integration.test.ts의 human attachment-only event→handler→Mastra/DeepSeek SSE SDK→silent Slack Web API SDK with injected HTTP→live files.info authorization→hardened mock download + inline mock vision→progress/renderer/final stream.
- **real library/disk:** 위 handler의 real SQLite shutdown/reopen/new handler context 복구, 실패/abort commit fence/actor/team/thread checks, session startup/close corruption tests. SQLite foundation bounds/schema/quota/TTL tests도 그대로 실행.
- **actual PDF.js:** pdf-installed.test.ts는 real PDF bytes를 설치된 PDF.js child로 추출한다. 기존 synthetic module parser isolation tests와 구분한다. Node24 built dist의 설치 module file URL/추출/missing-module 경로도 별도 확인한다.
- **CLI:** actual createChat SDK loop의 fetch→재호출 read_more와 다른 세션 denial, 일반 library 두 도구 compatibility, dist CLI/Slack --help.
- **deployment:** fake deploy/signature/installer/rollback/env allowlist security tests. synthetic Compose parse 및 local network-none Docker image smoke의 rootless private volume seed/reopen 계약. 이것은 운영 서버/cgroup 부하 증거가 아니다.

### Supplemental runtime/tool delta 검증

`revision-regressions.test.ts`는 raw8KB 안의 secret-bearing file candidates가 redaction 후48KB를 넘는 실제 handler 입력을 거부하고, sanitized history의 whole-pair pruning 성공 및 summary/redaction 이후 final fence를 검사한다. **Real SQLite second connection**이 성공 ordinary post와 성공 stopStream callback 내부에서 `BEGIN IMMEDIATE`를 잡아 set 실패를 유발하며, 한 답변 + 정확한 save-failure 안내 + 기존 쌍 재개방 보존을 확인한다. 별도 테스트는 live DB row corruption에서 chat 미실행/원문 미삭제, ambiguous final write 추가 안내 없음, confirmed-delivery deadline late-write fence, stalled ancillary notice5s/no-recursion 및 explicit429에서도 부수 안내를 재시도하지 않음을 검사한다. `tool-output.test.ts`는 cycle/BigInt/undefined/throwing toJSON을 static result로 처리하고 private 오류/body를 반환하지 않으며 provider serialization을 한 번만 실행하는 inert snapshot을 검사한다. 모두 offline synthetic Slack/provider callbacks와 실제 private temporary SQLite이며 운영 성공 주장이 아니다.

실제 Slack scopes/RTS/action_token/files/plan task_update 화면/Block Kit·알림·접근성 클라이언트, 실제 DeepSeek/선택한 Vision 모델 지원·품질·과금, 운영 install/volume/rollback/서명 bootstrap은 **미실행**이다. owner가 승인된 실제 설치에서 별도로 검증해야 하며 이 PR은 서버/DB/.env/실제 Slack/provider에 접근하거나 사용자 OAuth/취소 UI/조직 integration을 추가하지 않는다.
