# Slack 실행과 안전한 스레드 맥락

## 설치 및 실행

Node.js **24 이상**, npm, 장기 실행할 단일 프로세스가 필요하다. HTTP 서버/요청 URL/Signing Secret은 필요 없으며 Socket Mode의 outbound WebSocket 연결을 사용한다. Docker·서버 배포·운영 Slack 앱 변경은 이 구현의 범위가 아니다.

1. Slack 앱 생성 화면에서 **From a manifest**로 [`slack-manifest.json`](./slack-manifest.json)을 붙여 넣고 대상 워크스페이스에 생성한다. 기존 앱에 적용한다면 이벤트/Socket Mode/권한을 직접 비교한다. 이 코드는 실제 앱 설정을 변경하지 않는다.
2. Socket Mode가 켜져 있는지 확인한다. Basic Information → App-Level Tokens에서 **`connections:write`** 권한의 토큰을 만들고 `xapp-` 값을 `SLACK_APP_TOKEN`에 넣는다. 이는 bot OAuth scope가 아니어서 manifest의 bot scopes에 넣지 않는다.
3. OAuth & Permissions → Install to Workspace에서 설치 승인 후 **Bot User OAuth Token(`xoxb-`)**을 `SLACK_BOT_TOKEN`에 넣는다. 사용자 토큰(`xoxp-`), 사용자 OAuth, 별도 인증 전환 경로는 지원하지 않는다. Slack SDK의 OAuth 관련 전이 의존성은 있어도 설치 저장소/클라이언트 ID/secret/OAuth 서버는 사용하지 않는다.
4. bot event subscription은 `app_mention`, `message.im`. bot scopes는 `app_mentions:read`, `chat:write`, `im:history`, 공개 스레드용 `channels:history`, 비공개 스레드용 `groups:history`, live `conversations.info/members`용 `channels:read`, `groups:read`, `im:read`, 첨부 metadata용 `files:read`, RTS 검색용 `search:read.public`. 비공개 채널을 사용하지 않으면 생성 전에 `groups:history`를 제거해 최소 권한으로 설치할 수 있다. 권한 변경 뒤에는 **재설치/재승인**하고 토큰과 멤버십을 다시 확인한다. `chat:write.public`, 사용자 history 권한, `mpim:history`는 필요하지 않다.
5. 대상 공개/비공개 채널에 `/invite @my-mastra`로 bot을 초대한다. DM은 앱의 Messages 탭에서 메시지를 보낸다. Slack Connect/조직 배포/다중 워크스페이스/그룹 DM은 대상이 아니다.
6. `.env.example`을 로컬 `.env`로 복사해 DeepSeek 키와 위 두 Slack 토큰을 설정한다. 실제 값을 Git/로그/PR/Slack 대화에 붙이지 않는다.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run start:slack
# 개발 실행: npm run dev:slack
# 키 없이 도움말: npm run start:slack -- --help
# 기존 CLI는 Slack 키 없이 유지: npm start -- --help
```

`DEEPSEEK_API_KEY` 필수, `DEEPSEEK_MODEL` 기본 `deepseek-chat`, `EXA_API_KEY` 선택. CLI/Slack 각각의 **실행 entry에서만** `.env`를 읽고 기존 프로세스 환경이 우선한다. 라이브러리 import 시 환경/모델/네트워크를 초기화하지 않는다. SDK 로그는 정적 코드만 남기며 본문·토큰·공급자 원문 오류는 출력하지 않는다. bot/app 토큰의 접두사를 명시 검증하지만 실제 설치 유효성은 Slack 시작 시 확인한다.

## 수신과 문맥의 경계

- **사람의 채널 `app_mention`**, **사람의 DM(`message.im`)**만 수신한다. 자기 bot/다른 bot, 수정/삭제, 다른 subtype 이벤트는 실행하지 않는다. 유일한 예외는 원래 사람이 작성한 `file_share`이며 bounded valid file 후보가 있어야 한다. attachment-only DM/멘션도 지원하고 hidden/봇/수정/삭제 wrapper는 거부한다.
- bot 자신의 `<@ID>`만 제거하고 다른 사람 멘션은 데이터로 보존한다. 응답은 언제나 해당 이벤트의 `thread_ts`(없으면 `ts`)에 게시한다. 도구 진행은 선택적 plan/task_update 스트림으로 표시하고, 최종 답변은 한 번 완성해 게시한다. 텍스트 토큰 streaming, 취소 버튼/registry, reaction relay, feedback/비용 footer는 없다.
- 채널 **최상위 멘션**은 이벤트 본문만 JSON 데이터로 전달한다. 다른 이력을 검색하거나 로컬 이력과 섞지 않는다.
- **기존 스레드 멘션**은 Socket Mode 이벤트에서 얻은 channel/root/current만, 같은 bot credential의 silent `createSlackReadClient` transport로 `conversations.replies` 조회한다. 각 페이지는 invocation WeakMap context와 signal을 사용하고 live origin requester/workspace 접근을 재검증한다. 이 자동 맥락 조회는 모델 인자를 사용하지 않는다. 별도 읽기 도구는 매 호출 live 권한을 검사하며 사용자 OAuth fallback은 없다.
- 모든 cursor 페이지를 읽고 root/current 존재, current 작성자 및 **event 본문과 current 본문 일치**, root의 `reply_count`, 중복 메시지 일관성, 반복 cursor, 빈/비정상 페이지, warning/error 및 `has_more`를 검사한다. root부터 현재 멘션까지 시간순으로 전달하고 현재 입력을 별도 덧붙이지 않는다. 이후 댓글도 전체성 검사에는 포함하지만 현재 요청의 모델 문맥에서는 제외한다. 조회 중 편집/댓글 수 race는 재조회/추정하지 않고 실패 폐쇄한다. 사람의 원래 `file_share`만 빈/없는 text와 제한된 후보 metadata를 JSON 데이터로 표현한다. current text/subtype/file 후보 일관성도 검사하며 그 외 시스템/subtype/비정상 file metadata는 실패한다.
- 본 bot의 user ID(또는 user가 없는 경우에만 trusted bot ID)에 해당하는 과거 발화만 native `assistant`. 사람/다른 bot은 `user`. 다른 user와 본 bot ID가 함께 오는 모순된 메시지는 본 bot으로 승격하지 않는다. JSON의 author/ts/text 및 요약은 **비신뢰 참고 데이터**이며 인증·승인·역할 변경/권한의 근거가 아니다.
- 첨부 후보는 내용이나 권한이 아니다. 등록된 문서/이미지 도구로 live 현재 채널 exact-message→file 관계, 요청자 접근, bot access, fresh `files.info`와 다운로드 직전 접근을 재검증한 경우만 읽는다. 검색 snippets/타 채널 IDs는 파일 권한을 넓히지 않는다. 문서/이미지 한도와 외부 전송은 [slack-attachments.md](slack-attachments.md) 참고.
- DM만 team/channel/thread별 **성공한 최종 전달 후** canonical sanitized Markdown의 완전한 user/assistant 쌍을 로컬 SQLite에 저장한다. 기본 `.local/slack-history/history.sqlite`, 로컬 선택 `SLACK_HISTORY_DB`. 기존 user author가 현재 actor와 다르면 실패 폐쇄한다. 최상위 DM은 새 스레드이며 같은 스레드 reply만 이어진다. 채널 원문은 항상 Slack이 권위적이며 로컬 history와 섞지 않는다. 일반 실패는 자기 DM key만 제거하고 abort/shutdown/저장소 오류에서는 이전 쌍을 보존한다. 종료는 abort/drain 후 close하며 삭제하지 않는다. 상세 [slack-history.md](slack-history.md). Mastra Agent Memory/storage와는 별개다.

## 전체성·요약·운영 한도

한도는 `src/slack/limits.ts`의 정적 기본값이며 임의 환경변수로 해제하지 않는다.

| 대상 | 한도 / 정책 |
| --- | --- |
| 이벤트 본문 | 8,000 UTF-8 byte, 초과 시 모델 미실행 |
| Slack 조회 | 페이지당 `limit:15`, 최대 1,000페이지 / 투영한 원문 4,000,000 UTF-8 byte |
| 모델 대화 문맥 | **roles/content를 포함한 전체 JSON 직렬화 기준 48,000 UTF-8 byte** (system/tool schema와 토큰 수는 별도) |
| 요약 | 동일 DeepSeek 설정 모델, 도구 없음, root와 오래된 모든 댓글을 순차 rolling 요약; JSON 입력 48,000 byte 이하, 출력 8,000 byte 이하·1,500 output tokens·retry 0 |
| 답변 생성 | 최대 6단계 / 4,096 output tokens, model retry 0 |
| 전체 요청 | admission부터 큐 대기+문맥 조회+모든 요약+생성+최종 게시까지 90초 |
| 큐/동시 실행 | 전체 admission 32, 스레드당 4, 독립 스레드 동시 2; 같은 team/channel/thread는 직렬 |
| 중복 이벤트 | 실행 중 억제 + 성공/실패/과부하 후 10분 TTL·최근 최대 512건. team과 event ID 기준(없으면 채널/ts/user 해시) |
| DM 영속 history | 7일 TTL, 128스레드, 전체 JSON 1MB, 스레드당 48KB·12턴; 오래된 **완전한 쌍**만 제거 |
| Slack API | SDK 요청 timeout 10초, SDK retry 0, 명시적 rate limit 거절만 2초 이하 Retry-After일 때 한 번 재시도. 긴 rate limit·일반/불확실한 전송 실패는 재시도하지 않음 |
| 진행 UI | 요청당 최대 24 tasks / 48 updates, 정적 알려진 도구 레이블과 상태만, API 실패 재시도 없음 |
| 오류 안내 | 최종 답변 쓰기를 시도하기 전의 실패에 대해, 만료된 요청 밖에서 한국어 고정 안내 1회만, 최대 5초; 별도 최대 2개 동시·스레드당 1개, 큐 없음·초과 안내 생략, 실패도 재귀 재시도 없음 |
| 시작/종료 | 시작 최대 30초, SIGINT/SIGTERM은 admission 중단+큐/active abort+drain+SQLite close(삭제 없음), SDK stop 최대 5초 뒤 executable 종료 |

48KB를 넘으면 **root 원문 + 명시된 오래된 댓글 요약(user 데이터) + 연속된 최근 댓글 원문/현재 멘션**을 전달한다. 요약 입력에 root를 seed로 넣고 오래된 모든 댓글을 원래 순서대로 한 번씩 반영한다. 실제 JSON escaping을 기준으로 검사하고 root/current를 자르거나 오래된 댓글을 조용히 버리지 않는다. root/current 보존 불가능, 한 댓글/누적 요약 입력이 너무 큼, 요약 실패/빈 출력/크기 초과/잘린 finish reason, Slack 부분조회/권한 오류 시 **답변 모델을 실행하지 않고** 한국어 실패 안내만 보낸다. 요약을 사용한 답변에는 고정 안내도 붙인다. 요약 품질·정확성과 프롬프트 인젝션 완전 방어를 보장하지는 않는다.

요청 만료 시 모델/요약/조회에 abort를 전달하고 늦은 결과의 게시·DM history commit을 차단한다. 실행 중 의존성이 abort를 무시하면 그 작업이 끝날 때까지 admission/concurrency/thread 슬롯을 유지해 무한 zombie 실행을 방지한다(따라서 새 요청이 과부하로 거절될 수 있음). Slack API race-abort 이후 SDK의 남은 HTTP 작업은 자체 timeout으로 제한된다. 오류 안내도 별도 bounded 슬롯을 사용해 과부하 이벤트가 무제한 Slack API 호출로 바뀌지 않으며 shutdown 시 abort한다. 종료 entry는 남은 socket/SDK 작업 때문에 프로세스가 무한 대기하지 않도록 최종 exit한다.

**단일 프로세스, 무영속 best-effort 중복 억제**다. TTL/건수 밖 재전달·재시작·동시 여러 프로세스에서는 중복 생성/게시가 가능하다. 게시 후 응답 유실 등 분산 exactly-once를 보장하지 않는다. durable request queue/수평 확장/토큰 회전 자동화는 없다. 성공 DM history의 SQLite 영속성과 event 중복 억제는 별개다. 요청 기한은 엄밀한 공급자 과금 상한이 아니므로 별도 계정 예산과 저권한 키를 사용한다.

## 선택적 도구 진행 스트림

Slack 답변만 Mastra `agent.stream`의 `fullStream`을 소비한다. tool-call/result/error는 안정적인 `toolCallId`로 연결하되 Slack에는 요청 내 `task-1` 같은 불투명 ID만 전달한다. 알려진 웹/Slack 읽기/파일/이미지 도구의 **정적 레이블 + in_progress/complete/error**만 보낸다. 웹 continuation/Slack 읽기/첨부/이미지 도구가 실제로 등록된다. 레이블·progress 자체는 접근 권한이 아니다. 인수·결과·URL·검색어·Slack 본문·동적 도구명은 진행 카드나 로그에 넣지 않는다. 최종 text와 finishReason을 기다리고 error/불완전 종료는 답변으로 인정하지 않는다. 요약/CLI 생성 방식과 한도는 그대로다.

`chat.startStream`은 plan 모드, 원래 channel/thread, 검증된 이벤트의 team/requester를 recipient로 사용한다. 선택적 `apiCall`이 없는 주입 client 또는 명시적 platform start 거절(`ok:false`/SDK `data.error`, 동기 throw 포함)은 부수적 UI 실패로 처리하고 모델을 한 번 실행해 기존 `postMessage`로 최종 답변 한 번만 보낸다. append 실패도 유효한 최종 답변을 막지 않는다. start의 불확실한 쓰기 실패는 모델을 실행하지 않고 고정된 bounded 오류 안내 한 번으로 알린다. 성공한 open 뒤 모델/불완전 종료/deadline 실패도 plan cleanup과 별도로 정상 bounded 오류 안내를 보낸다. 빈 진행 plan은 최종 답변이 아니므로 안내를 억제하지 않는다. ordinary 최종 post 또는 최종 stop 쓰기를 시도한 뒤에는 불확실한 실패/abort 시 재시도하거나 일반 메시지·추가 오류 안내로 중복 게시하지 않는다. 유일한 별도 안내는 accepted 응답으로 최종 전달이 **확인된** 뒤 DM history 저장이 실패했을 때의 static “답변은 전송했지만 대화 기록 저장에 실패했습니다…”이며, 기존 쌍을 보존하고 별도5초/최대2개/same-thread1개/no-queue lifecycle로 best effort 전송한다. 이 경우 모델을 실패로 재분류하거나 답변을 다시 만들지 않는다. UI 복구를 위해 모델을 다시 실행하지 않는다. 최종 정제·렌더링 블록은 `stopStream`에 한 번만 전달하며 성공한 전달만 DM canonical Markdown history에 반영한다.

열린 스트림은 오류/90초 deadline/shutdown에서도 최종 본문 없이 최대 5초의 별도 cleanup으로 한 번만 닫는다. 생성 응답이 늦게 성공해도 ts를 추적해 같은 bounded cleanup을 적용하며 늦은 답변/history commit은 금지한다. 불확실한 stop 쓰기를 반복하지 않으므로 네트워크/Slack 실패 시 UI 종료를 보장하지는 않는다. SDK timeout/retry 0은 그대로이며 cleanup은 요청 기한과 별도로 수행한다. 비협조적 모델의 admission/thread 슬롯 정책도 변경하지 않는다.

Shookie PR [#39](https://github.com/yourssu/shookie/pull/39)와 streaming/handlers를 읽기 전용 참조했다. 원본의 인수/결과 표시, 임의 오류 로그, 모호한 쓰기 후 fallback, 피드백 버튼은 가져오지 않았다. synthetic API/handler 테스트와 실제 Mastra/DeepSeek SDK를 통과하는 mocked SSE(tool-call/result, 최종 text/finishReason)만 검증했다. **실제 Slack plan/task_update 스키마·화면 및 실제 공급자 E2E는 미검증**이다. 운영 설정·실제 Slack 호출은 하지 않았다.

## Slack API 제약과 설치 환경 확인

공식 참조: [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [pagination](https://docs.slack.dev/apis/web-api/pagination/), [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

**bot token으로 채널 스레드 전체 조회가 항상 가능하다고 보장하지 않는다.** Slack의 token type/history scope 설명과 실제 설치 유형/멤버십/채널 정책은 다를 수 있고 `not_allowed_token_type`, `missing_scope`, `no_permission`, rate limit 등이 발생할 수 있다. 이 경우 user token이나 과도한 권한으로 우회하지 않고 fail-closed 한다. DM/최상위 멘션이 성공해도 기존 채널 스레드 조회 성공을 뜻하지 않는다.

상업적 비-Marketplace 앱/설치 유형에 따라 `conversations.replies`에 1분당 1회·페이지 최대 15개 제한이 적용될 수 있다. 내부 앱 등의 별도 tier 정책은 실제 설치 유형으로 확인한다. 보수적인 limit 15와 90초 전체 기한 때문에 큰 스레드/강한 rate limit은 의도적으로 실패할 수 있다. 실패했다고 제한을 무제한 늘리거나 일부 페이지만 모델에 보내지 않는다.

설정 후 실제 설치에서 별도로 확인할 체크리스트:

- 공개/필요한 비공개 채널 초대, 권한 재설치, **bot token만으로** root/current/여러 페이지 조회.
- 여러 사람이 참여한 기존 스레드의 역할/current 중복 없음, 다른 bot을 본 bot으로 오인하지 않음.
- 권한 회수/잘못된 token type/부분 응답/큰 스레드/rate limit에서 실제 답변 모델이 미실행되고 안전한 안내만 게시되는지.
- DM과 같은 스레드의 최근 대화, SIGTERM 재시작 시 성공한 DM 대화의 디스크 복구, Slack UI의 Markdown 구조·mention 방지 출력.
- 실제 DeepSeek 요약/답변 품질·비용·지연과 외부 검색 정책.

**이번 PR에서는 실제 Slack/LLM 네트워크 E2E 및 앱 설정 변경을 실행하지 않았다.** synthetic Slack 페이지/이벤트 → handler/runtime → model mock → 게시, 실제 Mastra/DeepSeek SDK를 mocked fetch로 통과하는 경계 테스트만 검증한다. 도움말/빌드 통과는 실제 설치 검증과 다르다.

## 출력과 데이터 처리

출력 경계에서 정제된 표준 Markdown을 Slack Block Kit으로 변환한다. h1–h6는 150 units 이하일 때 `plain_text` header, 긴 제목은 잘림 없이 강조 section으로 표시한다. 구분선은 divider, 문단·목록·인용·굵게/기울임/취소선은 `mrkdwn` section이다. 한글 등 CJK 문자가 굵게 여는/닫는 경계에 붙으면 표시용 공백을 보정한다. intraword underscore 식별자는 변환하지 않는다. 표는 **모든 열 이름과 값을 유지하는 행별 카드**로 바꾸며, 코드 안의 Markdown은 변환하지 않는다. 긴 단일 행/코드는 Unicode codepoint·escaped entity를 보존하며 분할하고 코드/강조 경계를 각 section에서 닫는다. Slack fence로 표현할 수 없는 literal backtick 코드는 읽을 수 있는 plain-text로 표시한다. 빈 fence는 언어 정보와 빈 코드 안내를 보존한다. 인접 문단과 표 카드는 빈 줄 경계를 유지하며 section 한도 내에서 묶고 제목/구분선은 독립 구조를 유지한다. footer/버튼은 추가하지 않는다.

`plain_text` 제목과 literal backtick 코드 section에는 정제된 원문을 그대로 넣어 `&<>`와 기존 `&lt;` 같은 literal entity를 보존한다. `mrkdwn`과 fallback 경로에서는 모델의 `&<>` 및 기존 entity를 먼저 escape하며, 원래의 `<@user>`, `<#channel>`, `<!everyone>`, `<URL|label>` 같은 Slack control은 실행하지 않는다. 검증한 public DNS 호스트의 HTTP(S) Markdown 링크만 안전한 labeled link로 생성한다(인증 정보·IP·local/internal 호스트·control delimiter 등은 거부). 거부되거나 너무 긴 링크는 레이블과 URL을 읽을 수 있게 보존한다. 이는 DNS/네트워크 도달성 검증이나 DLP가 아니다. 접근성 fallback은 제목·표의 열/값·코드·URL을 포함한 escaped 읽기용 텍스트이며 `mrkdwn:false`, `parse:none`, `link_names:false`, 링크/미디어 unfurl off를 유지한다.

원문과 변환된 블록 본문 모두 최대 20,000 UTF-16 units / 40,000 UTF-8 byte, section 최대 2,800 units, 최대 40 blocks, escaped fallback 최대 39,000 units / 40,000 byte를 적용한다. escape·URL 정규화·표 열 이름 반복·코드 분할 확장도 한도에 포함한다. 초과/빈 응답은 **부분 잘림 대신 고정 한도 안내**로 대체한다. 토큰/설정된 API 키는 변환 전 제거하지만 임의 비밀 전체를 탐지하는 DLP는 아니다. DM history에는 성공적으로 전달된 정제 Markdown 원문만 보존하며 블록에서 대화를 재구성하지 않는다. 표시용 요약 안내는 canonical answer와 별도로 관리하고 history에 넣지 않는다. 오래된 스레드 요약 안내는 최종 원문에 한 번 추가하고 전체를 검증·렌더링한다.

한국어 회의 요약을 흉내 낸 synthetic 테스트로 구조·payload 안전성·Unicode/변환 한도·DM history를 검증했다. 실제 Slack 화면의 plain-text 디코딩/시각적 렌더링·알림·접근성 클라이언트 또는 실제 LLM E2E는 실행하지 않았다. 렌더링 참조는 `yourssu/shookie` PR #38·#47·#51·#52이며, 원본의 긴 행 한도 초과 및 조용한 블록 잘림 동작은 가져오지 않았다.

Slack의 원문과 요약은 **외부 서비스 DeepSeek로 전송**된다. 사용자에게 회사/개인 비밀을 입력하지 않도록 알리고 조직의 동의·보존·국외전송 정책을 확인해야 한다. 원문 텍스트/작성자 ID/시각이 포함될 수 있다. 공개 웹 도구는 검색·fetch·이어 읽기·본문 리터럴 검색 네 개이며 외부 검색은 Exa, URL fetch는 해당 공개 호스트에 전송된다. Slack 본문/개인정보/토큰/비밀을 검색어/URL로 보내지 않도록 지시하지만 모델 지시만으로 유출을 완전히 막는다고 보장하지 않는다. 민감한 채널에는 설치하지 말고 필요한 경우 별도 egress/DLP 정책을 갖춘다.

참고 원본: `yourssu/shookie` PR #89(전체 스레드 맥락)·#81(동시 실행), main `d7ea5a82aa4e034a7a3ede2ceefedfcbfa6b8004`. 필요한 경계/알고리즘만 독립적으로 재구현했으며 원본은 변경하지 않았다. Shookie 조직 프롬프트/사내 API/DB/자산/출석/회의/멘션 그룹/리액션/사용자 OAuth/비용·feedback UX/운영 배포 설정은 가져오지 않았다.
