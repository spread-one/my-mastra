# Slack 실행과 안전한 스레드 맥락

## 설치 및 실행

Node.js **24 이상**, npm, 장기 실행할 단일 프로세스가 필요하다. HTTP 서버/요청 URL/Signing Secret은 필요 없으며 Socket Mode의 outbound WebSocket 연결을 사용한다. Docker·서버 배포·운영 Slack 앱 변경은 이 구현의 범위가 아니다.

1. Slack 앱 생성 화면에서 **From a manifest**로 [`slack-manifest.json`](./slack-manifest.json)을 붙여 넣고 대상 워크스페이스에 생성한다. 기존 앱에 적용한다면 이벤트/Socket Mode/권한을 직접 비교한다. 이 코드는 실제 앱 설정을 변경하지 않는다.
2. Socket Mode가 켜져 있는지 확인한다. Basic Information → App-Level Tokens에서 **`connections:write`** 권한의 토큰을 만들고 `xapp-` 값을 `SLACK_APP_TOKEN`에 넣는다. 이는 bot OAuth scope가 아니어서 manifest의 bot scopes에 넣지 않는다.
3. OAuth & Permissions → Install to Workspace에서 설치 승인 후 **Bot User OAuth Token(`xoxb-`)**을 `SLACK_BOT_TOKEN`에 넣는다. 사용자 토큰(`xoxp-`), 사용자 OAuth, 별도 인증 전환 경로는 지원하지 않는다. Slack SDK의 OAuth 관련 전이 의존성은 있어도 설치 저장소/클라이언트 ID/secret/OAuth 서버는 사용하지 않는다.
4. bot event subscription은 `app_mention`, `message.im`. bot scopes는 `app_mentions:read`, `chat:write`, `im:history`, 공개 스레드용 `channels:history`, 비공개 스레드용 `groups:history`. 비공개 채널을 사용하지 않으면 생성 전에 `groups:history`를 제거해 최소 권한으로 설치할 수 있다. 권한 변경 뒤에는 **재설치/재승인**하고 토큰과 멤버십을 다시 확인한다. `chat:write.public`, 사용자 history 권한, `mpim:history`는 필요하지 않다.
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

- **사람의 채널 `app_mention`**, **사람의 DM(`message.im`)**만 수신한다. 자기 bot/다른 bot, 수정/삭제, 기타 모든 subtype 이벤트는 실행하지 않는다. 파일 공유 subtype도 제외한다.
- bot 자신의 `<@ID>`만 제거하고 다른 사람 멘션은 데이터로 보존한다. 응답은 언제나 해당 이벤트의 `thread_ts`(없으면 `ts`)에 게시한다. 일반 완성 응답이며 UI streaming/Agents AI app, 진행 메시지, reaction relay, feedback/비용 footer는 없다.
- 채널 **최상위 멘션**은 이벤트 본문만 JSON 데이터로 전달한다. 다른 이력을 검색하거나 로컬 이력과 섞지 않는다.
- **기존 스레드 멘션**은 Socket Mode 이벤트에서 얻은 channel/root/current만, 설정된 **bot client**로 `conversations.replies` 조회한다. 모델이 생성한 channel/thread 문자열로 조회하는 도구는 없고 사용자 OAuth fallback도 없다.
- 모든 cursor 페이지를 읽고 root/current 존재, current 작성자 및 **event 본문과 current 본문 일치**, root의 `reply_count`, 중복 메시지 일관성, 반복 cursor, 빈/비정상 페이지, warning/error 및 `has_more`를 검사한다. root부터 현재 멘션까지 시간순으로 전달하고 현재 입력을 별도 덧붙이지 않는다. 이후 댓글도 전체성 검사에는 포함하지만 현재 요청의 모델 문맥에서는 제외한다. 조회 중 편집/댓글 수 race는 재조회/추정하지 않고 실패 폐쇄한다. 원문의 text 없는 파일/시스템/subtype 메시지 등 안전하게 표현할 수 없는 응답도 실패한다.
- 본 bot의 user ID(또는 user가 없는 경우에만 trusted bot ID)에 해당하는 과거 발화만 native `assistant`. 사람/다른 bot은 `user`. 다른 user와 본 bot ID가 함께 오는 모순된 메시지는 본 bot으로 승격하지 않는다. JSON의 author/ts/text 및 요약은 **비신뢰 참고 데이터**이며 인증·승인·역할 변경/권한의 근거가 아니다.
- 첨부·파일·이미지는 내려받거나 해석하지 않고 text만 사용한다. 이를 읽었다고 답하지 않도록 지시한다.
- DM만 team/channel/thread별 최근 **성공한** user/assistant 쌍을 프로세스 메모리에 보관한다. 최상위 DM마다 새 스레드이므로 지난 최상위 DM과 자동으로 이어지지 않는다. 같은 스레드에 답하면 이어진다. 실패한 대화는 해당 캐시를 비우고 채널 원문과 섞지 않는다. 재시작 시 모두 사라지며 DB/Agent Memory/외부 storage 어댑터/OAuth 설치 저장소를 사용하지 않는다. Mastra 자체의 기본 내부 store는 비영속 `in-memory`다.

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
| DM 캐시 | 30분 TTL, LRU 128스레드, 전체 JSON 1MB, 스레드당 48KB·12턴; 오래된 **완전한 쌍**만 제거 |
| Slack API | SDK 요청 timeout 10초, SDK retry 0, 명시적 rate limit 거절만 2초 이하 Retry-After일 때 한 번 재시도. 긴 rate limit·일반/불확실한 전송 실패는 재시도하지 않음 |
| 오류 안내 | 만료된 요청 밖에서 한국어 고정 안내 1회만, 최대 5초; 별도 최대 2개 동시·스레드당 1개, 큐 없음·초과 안내 생략, 실패도 재귀 재시도 없음 |
| 시작/종료 | 시작 최대 30초, SIGINT/SIGTERM은 admission 중단+큐/active abort+캐시 비움, SDK stop 최대 5초 뒤 executable 종료 |

48KB를 넘으면 **root 원문 + 명시된 오래된 댓글 요약(user 데이터) + 연속된 최근 댓글 원문/현재 멘션**을 전달한다. 요약 입력에 root를 seed로 넣고 오래된 모든 댓글을 원래 순서대로 한 번씩 반영한다. 실제 JSON escaping을 기준으로 검사하고 root/current를 자르거나 오래된 댓글을 조용히 버리지 않는다. root/current 보존 불가능, 한 댓글/누적 요약 입력이 너무 큼, 요약 실패/빈 출력/크기 초과/잘린 finish reason, Slack 부분조회/권한 오류 시 **답변 모델을 실행하지 않고** 한국어 실패 안내만 보낸다. 요약을 사용한 답변에는 고정 안내도 붙인다. 요약 품질·정확성과 프롬프트 인젝션 완전 방어를 보장하지는 않는다.

요청 만료 시 모델/요약/조회에 abort를 전달하고 늦은 결과의 게시·DM cache commit을 차단한다. 실행 중 의존성이 abort를 무시하면 그 작업이 끝날 때까지 admission/concurrency/thread 슬롯을 유지해 무한 zombie 실행을 방지한다(따라서 새 요청이 과부하로 거절될 수 있음). Slack API race-abort 이후 SDK의 남은 HTTP 작업은 자체 timeout으로 제한된다. 오류 안내도 별도 bounded 슬롯을 사용해 과부하 이벤트가 무제한 Slack API 호출로 바뀌지 않으며 shutdown 시 abort한다. 종료 entry는 남은 socket/SDK 작업 때문에 프로세스가 무한 대기하지 않도록 최종 exit한다.

**단일 프로세스, 무영속 best-effort 중복 억제**다. TTL/건수 밖 재전달·재시작·동시 여러 프로세스에서는 중복 생성/게시가 가능하다. 게시 후 응답 유실 등 분산 exactly-once를 보장하지 않는다. durable queue/저장소/수평 확장/토큰 회전 자동화는 없다. 요청 기한은 엄밀한 공급자 과금 상한이 아니므로 별도 계정 예산과 저권한 키를 사용한다.

## Slack API 제약과 설치 환경 확인

공식 참조: [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [pagination](https://docs.slack.dev/apis/web-api/pagination/), [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

**bot token으로 채널 스레드 전체 조회가 항상 가능하다고 보장하지 않는다.** Slack의 token type/history scope 설명과 실제 설치 유형/멤버십/채널 정책은 다를 수 있고 `not_allowed_token_type`, `missing_scope`, `no_permission`, rate limit 등이 발생할 수 있다. 이 경우 user token이나 과도한 권한으로 우회하지 않고 fail-closed 한다. DM/최상위 멘션이 성공해도 기존 채널 스레드 조회 성공을 뜻하지 않는다.

상업적 비-Marketplace 앱/설치 유형에 따라 `conversations.replies`에 1분당 1회·페이지 최대 15개 제한이 적용될 수 있다. 내부 앱 등의 별도 tier 정책은 실제 설치 유형으로 확인한다. 보수적인 limit 15와 90초 전체 기한 때문에 큰 스레드/강한 rate limit은 의도적으로 실패할 수 있다. 실패했다고 제한을 무제한 늘리거나 일부 페이지만 모델에 보내지 않는다.

설정 후 실제 설치에서 별도로 확인할 체크리스트:

- 공개/필요한 비공개 채널 초대, 권한 재설치, **bot token만으로** root/current/여러 페이지 조회.
- 여러 사람이 참여한 기존 스레드의 역할/current 중복 없음, 다른 bot을 본 bot으로 오인하지 않음.
- 권한 회수/잘못된 token type/부분 응답/큰 스레드/rate limit에서 실제 답변 모델이 미실행되고 안전한 안내만 게시되는지.
- DM과 같은 스레드의 최근 대화, SIGTERM 재시작 시 cache 소멸, Slack UI의 plain-text 안전 출력.
- 실제 DeepSeek 요약/답변 품질·비용·지연과 외부 검색 정책.

**이번 PR에서는 실제 Slack/LLM 네트워크 E2E 및 앱 설정 변경을 실행하지 않았다.** synthetic Slack 페이지/이벤트 → handler/runtime → model mock → 게시, 실제 Mastra/DeepSeek SDK를 mocked fetch로 통과하는 경계 테스트만 검증한다. 도움말/빌드 통과는 실제 설치 검증과 다르다.

## 출력과 데이터 처리

출력은 Markdown을 **문자 그대로 보존하는 `plain_text` section blocks**(블록당 최대 2,800 UTF-16 units, 최대 40개)다. fallback은 `&<>` escaping, `mrkdwn:false`, `parse:none`, `link_names:false`, 링크/미디어 unfurl off. 모델의 `<@user>`, `<#channel>`, `<!everyone>` 등이 실제 mention으로 실행되지 않는다. 전체 본문 최대 20,000 UTF-16 units / 40,000 UTF-8 byte, escaped fallback 39,000 units. Unicode codepoint를 중간에서 자르지 않는다. 초과/빈 응답은 **부분 잘림 대신 고정 한도 안내**로 대체한다. 토큰/설정된 API 키가 모델 결과에 반영되어도 게시 전 제거하지만 임의 비밀 전체를 탐지하는 DLP는 아니다.

Slack의 원문과 요약은 **외부 서비스 DeepSeek로 전송**된다. 사용자에게 회사/개인 비밀을 입력하지 않도록 알리고 조직의 동의·보존·국외전송 정책을 확인해야 한다. 원문 텍스트/작성자 ID/시각이 포함될 수 있다. 공개 웹 도구는 그대로 두 개이며 외부 검색은 Exa, URL fetch는 해당 공개 호스트에 전송된다. Slack 본문/개인정보/토큰/비밀을 검색어/URL로 보내지 않도록 지시하지만 모델 지시만으로 유출을 완전히 막는다고 보장하지 않는다. 민감한 채널에는 설치하지 말고 필요한 경우 별도 egress/DLP 정책을 갖춘다.

참고 원본: `yourssu/shookie` PR #89(전체 스레드 맥락)·#81(동시 실행), main `d7ea5a82aa4e034a7a3ede2ceefedfcbfa6b8004`. 필요한 경계/알고리즘만 독립적으로 재구현했으며 원본은 변경하지 않았다. Shookie 조직 프롬프트/사내 API/DB/자산/출석/회의/멘션 그룹/리액션/사용자 OAuth/비용·feedback UX/운영 배포 설정은 가져오지 않았다.
