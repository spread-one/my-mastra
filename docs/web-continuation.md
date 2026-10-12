# 웹 본문 이어 읽기 기반 API

사용자 소유 Shookie PR90의 `src/tools/web/content.ts`, `tools.ts`, 테스트를 허가받아 이식·조정했다. Shookie 파일 변경이나 cancellation 모듈 의존성은 없다.

## 공개 도구 계약

`createWebTools({ exaApiKey?, network? })`의 기존 호출 계약을 유지하며 **기본값은 기존 `web_fetch`, `web_search` 두 도구**다. 기본 fetch는 continuation을 광고하지 않고 스냅샷을 저장하지 않으며 continuation 메타데이터도 반환하지 않는다. `createWebTools({ enableContinuation: true, exaApiKey?, network? })`로 명시적으로 opt-in하면 `web_read_more`, `web_find_in_content`를 포함한 네 도구와 continuation 출력이 활성화된다. 테스트용으로만 `contentStore?: ContentStore`를 주입할 수 있다. 운영에서는 기본 process-wide 저장소를 사용해야 도구 세트 재생성으로 할당량을 우회하지 않는다.

아래 스냅샷/창 계약은 `enableContinuation: true`일 때 적용된다.

- `web_fetch({ url, maxChars? })`: 기존 공개 URL 다운로드/SSRF 검증을 한 번 실행한다. HTML 정제, JSON pretty-print, 줄바꿈/공백 정규화 뒤 **고정 본문 전체**를 스냅샷에 저장하고 첫 창을 반환한다. `storage`는 `available`, `quota_exceeded`, `context_unavailable` 중 하나다. `available`일 때만 `contentId`, `expiresAt`이 있다. 저장 실패/컨텍스트 부재에도 기존 본문 읽기는 가능하다.
- `web_read_more({ contentId, offset, maxChars? })`: 같은 스냅샷의 다음 창. 기본 20,000, 최소 100, 최대 30,000 UTF-16 코드 단위.
- `web_find_in_content({ contentId, literal, offset?, count? })`: 기본 offset 0, count 10, 최대 20. literal은 1–400 코드 단위이며 공백만 있는 값, 잘못된 surrogate, 제어문자는 거부한다. 검색어를 trim하지 않는다. **대소문자 구분, 비중첩 literal 검색**이며 정규식을 해석하지 않는다. multiline/emoji를 지원한다. `matches`는 정확한 offset/endOffset/줄 범위와 일치 시작점의 제한된 snippet을 포함한다.

창은 `offset`, `endOffset`, `nextOffset`, `totalChars`, `totalBytes`, `offsetUnit: 'utf16_code_units'`, `lines`, `complete`, `truncated`를 반환한다. offset은 0부터, 끝은 제외한다. surrogate 쌍 내부 offset은 거부하고 창 끝도 쌍을 나누지 않는다. `nextOffset: null`은 끝이다. 빈 본문/끝의 빈 창은 성공이며 줄 범위는 0/0이다. 줄 번호는 1부터 시작하는 **정제 본문** 기준이고 원본 HTML 줄 번호가 아니다. 검색의 complete/truncated는 남은 literal 일치 여부다. 검색 snippet의 complete/truncated는 해당 본문 창의 끝 여부다. 바이트 수는 UTF-8 기준이다.

이어 읽기/검색은 다운로드하지 않는다. URL·title·contentType·fetchedAt은 최초 스냅샷 메타데이터를 유지한다. 검색 공급자 응답은 계속 `search_snippets`, 직접 가져온 본문과 그 literal 일치는 `fetched_text`다. 본문·제목·URL은 신뢰할 수 없는 데이터이지 지시/승인이 아니다.

## 후속 통합 PR: trusted RequestContext

이 PR은 웹 모듈 기반 구현이다. **실제 운영 핸들러의 trusted RequestContext 설정, CLI 세션 바인딩, 등록/설정/모델 수정은 후속 통합 PR 책임**이다. 후속 통합에서 trusted scope와 도구 사용 프롬프트를 준비한 뒤 `enableContinuation: true`를 명시해야 한다. 현재 운영 등록은 기본 두 도구를 유지한다. opt-in 후에도 컨텍스트가 없으면 이어 읽기는 닫힌 상태다.

Mastra Core 1.74의 서명은 `execute(input, context)`이며 `context.requestContext`와 `context.abortSignal`을 사용한다. 실제 SDK `Agent.generate` 루프 테스트로 컨텍스트 전달을 검증했다. 신뢰된 서버 핸들러가 인증된 이벤트로부터 다음 네 문자열을 채워야 한다:

```ts
import { RequestContext } from '@mastra/core/request-context';
const requestContext = new RequestContext();
requestContext.set('teamId', trusted.teamId);
requestContext.set('userId', trusted.userId);
requestContext.set('channel', trusted.channel);
requestContext.set('threadTs', trusted.threadTs);
await agent.generate(messages, { requestContext });
```

네 값 모두 1–100 코드 단위, 공백/ASCII 제어문자 없음이 필요하다. actor 할당량은 teamId+userId, 조회 권한은 teamId+userId+channel+threadTs 전체로 바인딩한다. 모델 도구 인자, 검색 결과, 본문, 사용자 텍스트에서 신원을 가져오면 안 된다. requestId 변경은 스냅샷 권한에 영향을 주지 않는다.

CLI 통합은 신뢰된 코드에서 프로세스/세션별 격리된 네 필드 바인딩을 제공하거나 `context_unavailable`을 명시해야 한다. 공유 전역 사용자 ID를 임의로 만들어 다른 세션에 재사용하면 안 된다. 누락된 범위는 `CONTENT_CONTEXT_REQUIRED`; foreign/unknown/expired/evicted ID는 모두 같은 `CONTENT_UNAVAILABLE`로 처리해 존재 여부를 공개하지 않는다. ID는 권한 자체가 아니다.

## 한도와 제한

- process-local TTL 10분, 최대 64개, 보수적 메모리 charge 16 MiB.
- actor당 최대 8개/4 MiB, 스레드를 바꾸어도 같은 actor 할당량. actor 초과는 새 저장을 거절하고 기존 본문을 보존한다.
- global 초과는 actor와 무관하게 가장 오래된 항목부터 FIFO 제거하며 조회는 TTL/FIFO 순서를 갱신하지 않는다. **다른 actor의 새 저장 때문에 TTL 이전에 스냅샷이 제거될 수 있다.** `expiresAt`은 최대 수명이지 그때까지 가용성 보장이 아니다. 권한 격리는 유지되지만 저장 가용성은 process-wide 용량을 공유한다. oversized 단일 항목은 거절한다.
- charge는 UTF-16 본문/메타데이터/범위 문자열과 항목당 1,024바이트 overhead. 문자열을 분리 복사해 큰 원본 substring backing store를 붙잡지 않는다. 이것은 JS 힙 전체의 정확한 RSS 한도가 아니라 보수적인 스냅샷 저장 한도다.
- 항목별 unref 타이머와 모든 작업의 TTL 검사로 만료를 제거한다. 재시작/다중 프로세스/다른 인스턴스에서는 ID를 공유할 수 없다. 영속 저장이나 자동 재fetch는 없다.
- 읽기 최대 UTF-8 90,000바이트; 일치당 snippet 1,000 코드 단위; 검색 최대 총 20,000 코드 단위/60,000바이트; 직렬화 성공 응답 최대 256 KiB.
- 기존 네트워크 한도 유지: wire/decoded body 1,000,000바이트, deadline 12초, redirect 3회. 본문 전체는 이 다운로드 한도 안에서만 보관한다. Exa 키 선택성/키 없는 MCP/공개 주소 검증/DNS pinning/비공개 주소 차단 유지.
- 설정된 `network.signal`은 SDK 신호가 없어도 유지하며, 둘 다 있으면 `AbortSignal.any`로 결합한 뒤 네트워크 deadline 신호와 결합한다(Node 24 엔진 지원). native 요청/본문 읽기에 전달하며 외부 abort도 현재 안전한 `TIMEOUT` 오류로 반환한다. 취소 UI나 Shookie 취소 코드가 없다. DNS 또는 주입 connector가 자체 중단을 지원하지 않으면 호출 결과만 즉시 종료되며, underlying 작업의 중단은 보장하지 않는다. 동기 파싱/문자열 검색은 실행 중 interrupt하지 않는다.
- 고정 정제 텍스트만 검색한다. 브라우저 JS·로그인·PDF·정규식·대소문자 무시·중첩 일치·원본 HTML 위치 매핑은 지원하지 않는다.

## 검증

`npm test`, `npx vitest run src/tools/web`, `npm run typecheck`, `npm run build` (각 최대 60초). 기본 두 도구 계약을 유지하므로 기존 agent/Slack 등록 테스트 수정이 필요 없다. continuation 테스트는 명시적 opt-in과 실제 SDK 컨텍스트 전달을 검증한다.
