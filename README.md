# my-mastra

공개 웹 도구와 제공된 대화 맥락을 참고하는 **독립 TypeScript ESM Mastra 에이전트**입니다. 로컬 터미널 또는 Slack 멘션/DM에서 DeepSeek와 대화하고, 필요할 때 `web_search` / `web_fetch` 두 도구만 사용합니다.

shookie의 에이전트 파일 분리 방식, 범용 웹 전송·Exa 프로토콜 및 안전한 Slack 스레드 맥락/동시 실행 경계를 바탕으로 필요한 부분만 독립시켰습니다. 조직 전용 프롬프트·설정·리소스, 사내 API, GitHub 저장소 복제, 데이터베이스 어댑터, OAuth 서버, 지속 메모리는 포함하지 않습니다. npm 패키지 배포는 하지 않으며 저장소를 복제해 사용합니다.

## 빠른 시작

**Node.js 24 이상과 npm**이 필요합니다. Mastra Core `1.74.0` / DeepSeek SDK `2.0.71`(각각 1.x / 2.x)을 고정하고 `package-lock.json`으로 의존성 전체를 재현합니다.

```sh
git clone https://github.com/spread-one/my-mastra.git
cd my-mastra
cp .env.example .env
# 편집기로 .env의 DEEPSEEK_API_KEY를 실제 로컬 키로 변경
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`.env.example`의 `your-deepseek-api-key`는 예시일 뿐이며 그대로 실행하면 친절한 설정 오류를 반환합니다. `.env`는 CLI/Slack의 실행 entry에서만 읽고, 기존 프로세스 환경 변수가 우선합니다. 키 없이도 설치·타입 검사·빌드·모든 테스트·`--help`는 가능합니다.

| 변수 | 필수 | 기본값 / 용도 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 채팅 시 필수 | DeepSeek 계정 API 키. 채팅 요청에만 사용 |
| `DEEPSEEK_MODEL` | 선택 | `deepseek-chat`; 예: `deepseek-reasoner`. 계정에서 지원하는 모델 ID 사용 |
| `EXA_API_KEY` | 선택 | 비어 있으면 키 없는 Exa MCP, 있으면 Exa REST 검색 |

DeepSeek 모델별 도구 호출 지원과 비용·한도는 공급자 정책을 따릅니다. 도구 호출을 지원하는 모델을 권장합니다. `web_fetch` 자체는 키가 필요하지 않습니다. **Exa 키가 없어도 검색 가능하지만 채팅에는 DeepSeek 키가 필요합니다.**

## CLI 사용

```sh
# 대화형: /exit 또는 EOF로 종료, /clear로 현재 대화 초기화
npm start

# 일회성 질문 (응답만 stdout에 출력)
npm start -- --prompt "TypeScript 공식 문서에서 최신 소개를 찾아 출처와 함께 요약해줘"
npm start -- -p "https://www.typescriptlang.org/docs/ 읽고 요약해줘"

# 도움말: 키 불필요
npm start -- --help

# 빌드 없이 개발 실행
npm run dev -- --prompt "공개 웹 검색 도구의 한계를 알려줘"

# stdin의 각 줄을 순서대로 질문으로 처리할 수도 있음
printf '첫 질문\n두 번째 질문\n/exit\n' | npm start
```

- 응답은 스트리밍하지 않고 완성 후 출력합니다. Ctrl+C / SIGTERM은 진행 중 요청을 취소합니다.
- 종료 코드: `0` 정상(도움말·EOF 포함), `1` 설정/모델/입출력 오류 또는 대화 중 실패, `2` 잘못된 CLI 인자, `130` 취소.
- 오류는 stderr로 출력하며 공급자 원문 오류·응답 본문·키는 출력하지 않습니다. 대화형 모델 오류 뒤에는 다음 질문을 받을 수 있지만 종료 코드는 `1`입니다.
- 질문 최대 8,000자, 출력 최대 20,000자, 생성 최대 6단계·단계당 출력 토큰 최대 4,096, 질문별 총 대기 최대 90초입니다. 공급자 과금의 엄밀한 상한은 아니므로 계정 예산을 별도로 설정하세요.
- CLI는 최근 사용자 질문/최종 응답을 최대 12턴·48,000자로 제한해 **프로세스 메모리에만** 보관합니다. 도구 실행 기록을 다음 턴에 저장하지 않으며, `/clear`와 종료 시 대화가 사라집니다. 입력 기록 파일이나 외부 저장소는 만들지 않습니다.
- Mastra Core의 기본 내부 `in-memory` store는 비영속적이며 이 프로젝트는 Agent Memory·외부 storage 어댑터를 등록하지 않습니다. Studio/HTTP 서버를 실행하지 않습니다.
- Core가 전이 의존성으로 포함하는 선택적 사용 통계 기능도 사용하지 않습니다. 에이전트 팩토리를 호출하면 프로세스의 `MASTRA_TELEMETRY_DISABLED=true`를 강제로 설정합니다(같은 프로세스의 다른 Mastra 인스턴스에도 적용). 별도 설정이나 키가 필요 없으며 라이브러리 import만으로는 환경을 변경하지 않습니다.
- 응답의 터미널 제어문자는 제거하지만, 모델 응답을 shell 명령으로 실행하지 마세요.

## Slack 사용

일반 Slack 봇의 Socket Mode로 채널 `app_mention`과 사람의 DM(`message.im`)에 완성 응답을 원래 스레드로 보냅니다. CLI와 별도 실행 모드이며 **기존 CLI에는 Slack 키가 필요하지 않습니다.**

```sh
# .env에 DEEPSEEK_API_KEY, SLACK_BOT_TOKEN(xoxb-), SLACK_APP_TOKEN(xapp-) 설정 후
npm run build
npm run start:slack
# 개발: npm run dev:slack
# 도움말은 키 없이 사용 가능
npm run start:slack -- --help
```

**실제 설치 절차·권한·개인정보·한도는 [docs/slack.md](docs/slack.md), 생성용 manifest는 [docs/slack-manifest.json](docs/slack-manifest.json)을 반드시 참고하세요.** App-level token에 `connections:write`, bot에 이벤트/history/게시 권한, 채널 초대와 권한 변경 후 재설치가 필요합니다. bot token의 채널 `conversations.replies` 지원은 실제 설치에서 확인해야 하며 실패/부분조회 시 답변 모델을 실행하지 않습니다.

기존 스레드 원문은 신뢰된 이벤트 대상만 전 페이지 조회합니다. 48,000 UTF-8 byte를 넘으면 같은 모델로 도구 없이 오래된 모든 댓글을 순차 요약하고 root/최근 원문/현재 입력을 보존합니다. DM만 team/channel/thread별 bounded process-memory 최근 대화를 사용합니다. 큐·중복 억제·동시 실행·요청 기한과 안전한 plain-text blocks 출력을 갖추지만 **무영속·단일 프로세스**이며 재시작/TTL 밖 중복은 보장하지 않습니다.

**Slack 데이터는 DeepSeek로 전송됩니다.** 비밀을 Slack/외부 검색에 입력하지 마세요. 실제 Slack/LLM E2E·앱 설정 변경·배포는 실행하지 않았고 설치 후 별도 검증이 필요합니다.

## SamKim self-host 자동 배포

공개 저장소에는 self-hosted runner를 등록하지 않습니다. **빌드는 GitHub-hosted Actions에서만** 하고 서버에서는 build하지 않습니다. PR/main CI 성공 뒤 **main push만** full-SHA linux/amd64 GHCR image를 발행하고, ephemeral tagged Tailscale OAuth → native Tailscale SSH → `samkim-deploy`의 고정 root-owned narrow sudo wrapper로 **explicit SHA/digest-pinned Compose**의 `bot`만 교체합니다. 실제 Slack 연결 readiness/zero restart 안정화 또는 rollback 결과가 remote exit status로 Actions deploy job에 반영됩니다. root-only app/code/Compose/env/state는 `/opt/samkim`에 고정하며 공유 `/srv/selfhost` 부모의 소유권은 변경하지 않습니다. wrapper 경로 `/usr/local/sbin/samkim-deploy`와 Compose project `my-mastra`는 유지합니다. polling/systemd timer는 없습니다.

**최소권한 인증·관리자 SSH 보존·GHCR Public 전환·host-only 키·retention/rollback/중지/업데이트·WSL 한계는 [docs/selfhost-deployment.md](docs/selfhost-deployment.md)를 참고하세요.** CI OS user는 Docker 그룹/일반 sudo 권한이 없고 wrapper의 두 검증된 argv만 허용합니다. local current/rollback + 최근 성공3 digest를 보호하며 앱 소유/미참조 이미지에만 non-force cleanup합니다. 별도 GHCR 자동 cleanup은 최근10 SHA roots +24h grace와 foreign/unknown graph를 보호하는 root-first best-effort이며 strict finite 개수 보장은 아닙니다. 실제 OAuth/vars/tag/ACL/account/bootstrap 준비 전에는 live deploy가 blocked이며 실제 Slack E2E 성공을 주장하지 않습니다. 외부 포트/일반 sshd/SSH key/hostkey bypass/전역 prune은 추가하지 않습니다.

```sh
npm run test:deployment  # fake Docker/Git/인증 argv-env/retention/설치/보안 계약
# 필요 시 Actions-built image만 smoke (빌드/실제 Slack 연결 없음)
bash deploy/smoke.sh ghcr.io/spread-one/my-mastra:sha-FULL_MAIN_SHA
```

## 두 웹 도구

### `web_fetch`

공개 HTTP(S) URL을 GET으로 읽어 UTF-8 HTML/평문/JSON을 추출합니다. HTML은 자바스크립트나 외부 리소스를 실행/로드하지 않는 파서와 Readability를 사용합니다.

입력: `{ url, maxChars? }` (`maxChars` 기본 20,000 / 100~30,000).

성공 결과에는 `evidence: "fetched_text"`, 원본/최종 URL, 읽은 시각, MIME, 제목, 텍스트, **반환된 추출 텍스트 기준 줄 범위**, `complete` / `truncated`가 포함됩니다. 줄 번호는 원본 HTML의 줄 번호가 아닙니다.

### `web_search`

입력: `{ query, count? }` (검색어 최대 400자 / 결과 수 기본 5, 1~10).

- 키 있음: 고정된 `https://api.exa.ai/search`에 REST POST, 키는 헤더에만 전달합니다.
- 키 없음: 고정된 `https://mcp.exa.ai/mcp?tools=web_search_exa`에 단일 `web_search_exa` MCP 호출을 POST합니다. 유한한 JSON/단일 SSE 응답만 처리하며 도구 발견·세션·재연결은 하지 않습니다.
- 결과 URL은 자동으로 읽지 않습니다. 성공 결과의 `evidence: "search_snippets"`는 공급자 검색 발췌이지 **직접 확인한 본문이 아닙니다**. 중요 주장은 별도 `web_fetch`로 확인하세요.
- 스니펫 최대 2,000자, 제목 최대 500자. 위험한 결과 URL을 걸러내고 잘림·필터링을 표시합니다. 결과 URL의 DNS는 실제 `web_fetch` 접속 시 검사합니다.
- `complete`는 반환된 응답이 로컬 제한으로 잘리지 않았다는 의미이며 **웹 전체 검색이 완전하다는 뜻이 아닙니다**. 날짜가 없으면 임의로 생성하지 않습니다.
- REST 인증/크레딧/요청 제한 오류 시 키 없는 검색으로 자동 전환하거나 재시도하지 않습니다. 키 없는 서비스도 무료 요청 한도·속도 제한·가용성 제약이 있습니다. 공급자 형식이 바뀌면 실패하도록 설계되어 있습니다.

모든 도구는 실패 시 안전한 오류 코드와 안내, 재시도 가능성, 제한값을 반환합니다. HTTP 401/402/429는 각각 키·크레딧·요청 한도 오류로 구분합니다.

## 공개 안전성과 신뢰 경계

- HTTP(S), 기본 포트만 허용하며 URL의 사용자 정보와 비공개/로컬 호스트명을 거부합니다. 사설·루프백·링크 로컬·메타데이터·멀티캐스트·예약 대역, 비공개 IPv4의 IPv6 매핑을 차단합니다.
- DNS 응답 **전체**가 공개 주소인지 확인한 뒤 검증된 IP를 실제 소켓 lookup에 고정합니다. TLS 호스트명과 인증서 검증은 유지합니다. DNS 재조회·공유 소켓 풀·프록시 환경 변수·브라우저 쿠키를 사용하지 않습니다.
- 각 리다이렉트에서 URL과 DNS를 다시 검사합니다. 공개 읽기는 최대 3회, Exa POST는 **리다이렉트 금지**여서 키/본문이 다른 호스트로 전달되지 않습니다.
- 요청 총 12초, 압축 전/해제 후 각각 최대 1,000,000바이트, 요청 헤더 최대 16KiB, Exa 요청 본문 최대 4,096바이트, HTML 요소 최대 30,000개로 제한합니다.
- SSRF 방어는 네트워크 계층의 강제 정책입니다. 그와 별도로 **웹 페이지·스니펫·제목·도구 결과는 신뢰할 수 없는 데이터**입니다. 에이전트 지시는 웹의 역할 변경·비밀 공개·내부 접속·추가 도구 설치·보안 우회 명령을 따르지 않도록 규정합니다.
- 프롬프트 인젝션을 모델 지시만으로 완전히 방지할 수 있다고 보장하지 않습니다. 사용자의 질문과 선택된 웹 내용은 DeepSeek에, 검색어는 Exa에, URL은 해당 공개 호스트에 전송됩니다. 개인/회사 비밀을 입력하지 말고 전용 저권한 키와 계정 예산을 사용하세요. 공개 주소라 해도 공격자 사이트일 수 있습니다.
- API 키는 모델 지시나 웹 도구 결과에 넣지 않습니다. DeepSeek 키는 해당 공급자, Exa 키는 고정 Exa REST 헤더에만 사용합니다. 일반 페이지 읽기에는 키나 인증 쿠키를 전달하지 않습니다.
- `.env`, `node_modules`, 빌드 산출물·로그는 Git에서 제외됩니다. `.env.example`에는 자리표시자만 있습니다. 실제 키를 커밋했다면 파일 삭제만 하지 말고 **즉시 폐기/재발급**하세요. 코드나 PR에 비밀을 붙이지 마세요.
- 공개 배포용 HTTP 서비스가 아닙니다. 서버로 확장할 경우 인증·요청 한도·추가 격리·네트워크 egress 정책을 별도 설계해야 합니다.

### 지원하지 않는 형식 / 기능

브라우저/JS 렌더링, 로그인·쿠키, PDF·이미지·영상·바이너리, UTF-8/ASCII 외 인코딩, 임의 헤더/POST, 비기본 포트, 사내·로컬 주소, 대용량 페이지는 지원하지 않습니다. MIME이 틀리거나 Exa MCP 구조가 예상과 다르면 안전하게 실패합니다. 정상 공개 페이지도 DNS·형식·크기 정책 때문에 거부될 수 있습니다. 웹 내용의 정확성·저작권·사이트 이용 정책 준수는 사용자가 확인해야 합니다.

## 구조와 프로그램 사용

```text
src/
  index.ts                    # 부작용 없는 공개 export
  config.ts                   # 환경 검증, 기본 모델
  mastra/index.ts              # createMastra(), main 등록
  agent/agents/main/
    index.ts                  # createMainAgent(model, webOptions)
    instructions.ts           # 범용 행동 / 웹 신뢰 경계
    description.ts
    tools.ts                  # web_fetch / web_search만 조합
  tools/web/
    network.ts                # 공개 URL·DNS 검증, IP 고정, 제한된 전송
    mcp.ts                    # 유한 MCP JSON/SSE 파싱
    tools.ts                  # 입력/출력 스키마, 추출, Exa 경로
  chat.ts                     # 생성 옵션 / 비영속 CLI 대화 제한
  cli/run.ts                  # 테스트 가능한 CLI
  cli.ts                      # CLI .env 로딩과 실행 진입점
  slack.ts                    # Slack 전용 .env 로딩과 signal/종료 entry
  slack/
    config.ts / run.ts        # xoxb/xapp 검증, Bolt Socket Mode 수명주기
    handlers.ts / runtime.ts  # 수신/게시, dedupe/직렬 큐/DM bounded memory
    context.ts / model.ts     # authoritative thread/byte budget/도구 없는 요약
    format.ts / limits.ts     # 안전한 plain-text blocks / 운영 한도
```

라이브러리 import는 `.env`를 읽거나 모델/네트워크를 초기화하지 않습니다. 호출 시 환경을 명시하거나, 호출자에서 `dotenv/config`를 로딩하세요.

```js
import 'dotenv/config'; // .env를 사용할 때 호출자가 선택
import { createMastra, loadConfig } from './dist/index.js';

const mastra = createMastra({ config: loadConfig() });
const agent = mastra.getAgent('main');
const result = await agent.generate('공개 웹 자료를 찾아 요약해줘', {
  maxSteps: 6,
  abortSignal: AbortSignal.timeout(90_000),
});
console.log(result.text);
```

`createMainAgent(model, webOptions)` 및 `createMastra({ model, webOptions })`에는 Mastra가 지원하는 모델을 직접 주입할 수 있습니다. `createWebTools({ exaApiKey?, network? })`는 채팅 키와 독립적입니다. `network`의 resolver/connector는 오프라인 테스트용 신뢰된 코드 경계이며 사용자·모델 입력으로 노출하지 마세요. CLI가 아니라 직접 `agent.generate()`를 호출할 경우 입력/출력/생성 제한과 오류 비밀 제거는 호출자가 책임집니다.

## 검증

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
node dist/slack.js --help
npm audit --omit=dev
```

테스트는 DNS/HTTP와 DeepSeek 응답을 모의 처리하므로 실제 키나 외부 서비스가 필요하지 않습니다. URL/IP 차단 코퍼스, 혼합 DNS·재바인딩 고정, 리다이렉트·키 분리, 타임아웃·압축 해제 크기 제한, MIME/추출, Exa REST/MCP 실패 폐쇄, 환경 검증, 실제 Mastra+DeepSeek SDK 도구 호출 루프, CLI 인자·오류·취소·대화 제한을 검증합니다. 소켓 고정 테스트 1개는 테스트 전용 루프백 HTTP 서버를 사용하며 실제 공개 요청은 하지 않습니다. GitHub Actions도 Node 24에서 비밀 없이 설치·타입 검사·테스트·빌드를 수행합니다.

Slack 합성 테스트는 pagination/root/current/역할/48000 byte/순차 요약 실패 폐쇄, handler 연결, 중복·직렬 큐·DM 격리·메모리 한도·기한/종료·비밀 없는 오류·안전 출력 한도를 검증합니다. 실제 Slack 설치/권한/채널 조회/출력과 실제 LLM E2E는 실행하지 않습니다.

실제 공급자 품질/과금/가용성은 모의 테스트의 검증 범위가 아닙니다. 의존성 업데이트 후 잠금 파일과 전체 테스트를 함께 갱신하세요.
