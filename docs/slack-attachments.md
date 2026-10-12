# Slack 첨부 문서·이미지 foundation

이 PR은 **등록되지 않은 주입형 도구 팩토리**만 제공합니다. 실제 Slack 권한 라이브러리, handler/agent 등록, manifest, 운영 설정은 후속 통합 PR의 책임입니다. 실제 Slack 파일·Vision 모델을 호출하지 않았으며 end-to-end 동작을 주장하지 않습니다. Shookie attachments/images 구현(PR92/94/95/97 관련)을 포팅했으며 cancellation 실행 컨텍스트는 가져오지 않았습니다.

## 제공 API

- `src/tools/attachments/tools.ts`: `createAttachmentTools(options)` → `slack_read_attachment`, 직접 호출 `readAttachment(input, options, requestContext?, signal?)`.
- `src/tools/images/tools.ts`: `createImageTools(options)` → `slack_analyze_image`, 직접 호출 `readImage(input, options, requestContext?, signal?)`.
- Mastra 실행 컨텍스트의 `requestContext`와 `abortSignal`을 전달합니다. 별도 취소 버튼이나 실행 모델 전환은 없습니다.
- 모델 입력: `fileId`, 정확한 `messageTs`, 선택적 `threadTs`. 문서는 1-based `unitStart`/`unitCount`, 리터럴 `query`; 이미지는 최대 1000자 `question`. URL, 토큰, 채널/사용자, 파서 경로, 모델/공급자 설정은 모델 입력으로 받지 않습니다.
- 문서는 UTF-8 TXT/Markdown 줄, CSV 행(인용부호 속 여러 줄 포함), PDF 페이지 단위입니다. CSV 셀은 순수 문자열이며 수식을 실행하지 않습니다. 전체/잘림/다음 단위와 원래 줄·페이지 출처를 반환합니다. Unicode 중간을 자르지 않습니다.
- 이미지는 PNG/JPEG 헤더만 검사합니다. 로컬 디코딩/OCR/렌더링을 하지 않습니다. 반환값은 `derived_image_interpretation`이며 **원문 텍스트 증거가 아닙니다**. 작은 글자·수치·추론은 원본과 대조해야 합니다.

## 단일 Slack 권한 capability 계약 (통합 필수)

`AuthorizeAttachment`는 서버만 주입합니다:

```ts
(fileId: string, messageTs: string, requestContext?: object,
 threadTs?: string, signal?: AbortSignal) => Promise<{
  file: { id: string; name: string; mimetype: string; size: number;
          url_private_download: string; mode?: string; is_external?: boolean };
  channelId: string;
  messageTs: string;
}>
```

이 함수는 단순한 `files.info` 조회가 **아닙니다**. 병렬 Slack worker의 기존 trusted request-context bridge와 서버 정책을 사용해야 합니다. 이 foundation은 별도 identity/권한 저장소 또는 Slack auth 구현을 만들지 않습니다. 모델이 만든 requester/channel 객체나 파일 ID만으로 권한을 부여하면 안 됩니다.

후속 `createSlackAttachmentOptions` adapter는 기존 live authority의 다음 인터페이스를 사용해야 합니다(이 PR은 해당 모듈을 import하지 않음):

1. `readAuthorizedSlackMessage(client, requestContext, {messageTs, threadTs?, channelId?}, signal?)`: 현재 요청자·workspace·현재 채널 접근을 실시간 검증하고 history/replies에서 **정확한 메시지**를 읽어 `{channelId, messageTs, threadTs?, fileIds}` 반환. 파일 ID 포함 여부와 스레드 루트 일치를 검사. 검색/다른 채널 fallback 금지.
2. `authorizeCurrentSlackChannel(client, requestContext, {channelId?}, signal?)`: 같은 trusted bridge를 통해 live 멤버십/서버 정책을 재검증. 반환 scope에는 `channelId`, `kind`, `identity: {channel, userId, teamId, requestId}`가 필요. 파일 조회 전후 scope/identity가 동일해야 함. 실제 라이브러리의 signal 전달 방식에 맞춰 adapter를 연결할 것.
3. 같은 기존 bot client로 `files.info`를 읽고 ID·MIME·size·다운로드 URL·mode·external 메타데이터를 검증. 성공 여부뿐 아니라 warning, missing scope, rate limit도 fail closed. 마지막 await에서 권한을 재검증하고 capability 결과를 반환; 캐시된 재사용 grant 금지.
4. 모든 호출에 요청 signal을 보존하고 deadline/중단을 지원해야 함. foundation은 capability의 내부 네트워크를 취소할 수 없으므로 무시하는 구현을 주입하면 안 됨.

`mode=hosted` 또는 생략된 hosted 메타데이터만 기본 허용. `mode=snippet`은 서버 metadata가 UTF-8 TXT/Markdown/CSV로 분류된 경우만 허용. 이미지/PDF snippet, 외부 파일, 알 수 없는 mode는 거부합니다. capability 반환 후에도 foundation이 이 제한과 정확한 file/message/channel 값을 검사합니다. 두 팩토리에 **같은 live authorize capability**를 주입하세요; 이미지에 문서 전용 MIME 필터를 쓰지 않되 mode 제한을 넓히지 마세요.

## PDF 의존성·격리 계약

통합 PR에서 추가할 정확한 runtime dependency: **`pdfjs-dist: 4.10.38`** (Shookie 기준). 현재 package/config/lockfile을 변경하지 않았습니다.

서버에서 설치된 `pdfjs-dist/legacy/build/pdf.mjs`를 resolve한 절대 `file:` URL을 `AttachmentToolOptions.parserOptions.pdfModuleURL`에 주입해야 합니다. 모델 입력이나 첨부 파일로부터 이 URL을 만들지 마세요. 예: 서버 ESM에서 `import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')`. PDF.js는 메인 프로세스가 아니라 제한된 별도 Node child에서 동적 import됩니다. 미설정/누락 모듈은 명시적 `PDF_UNAVAILABLE`; 파서가 없는 PDF를 정상 추출한 것처럼 반환하지 않습니다. 실제 PDF.js 추출/호환성 검증은 통합 이후 필수입니다. 현재 테스트의 성공 PDF 추출 경로는 **주입된 synthetic module 계약 검증**입니다.

PDF preflight는 PDF 1.0–1.7/EOF, 암호화, stream dictionary/길이/필터, 압축 해제량을 검사합니다. Flate 외 필터, 간접 길이, escaped dictionary key, `/F`, `/DP`, `/DecodeParms`는 보수적으로 거부합니다. 모든 정상 PDF를 지원하지 않습니다. OCR·스캔/빈 문서·암호화·Office는 지원하지 않습니다. eval/XFA/font/worker fetch/auto fetch를 비활성화합니다.

파싱은 최대 2개 child, 각각 128 MiB V8 heap와 5초 wall deadline. env는 PATH/LANG만 전달하고 stderr를 버립니다. 초과/중단 시 SIGKILL 후 **실제 close까지 슬롯을 유지**합니다. 압축 stream 2 MiB/합계 8 MiB, 50페이지, CSV 10000행/100열/16 KiB 셀, 파싱 텍스트 1 MiB, 반환 32 KiB. V8 heap 한도는 전체 RSS/OS sandbox가 아닙니다. 통합 배포의 프로세스/cgroup 리소스 제한을 병행해야 합니다. child는 네트워크 sandbox가 아니므로 trusted 파서 모듈만 사용해야 합니다.

## 다운로드·Vision 경계

- 다운로드는 HTTPS `files.slack.com/files-pri/`만 허용. userinfo/fragment/다른 port/인코딩된 traversal·separator/control 거부. public unicast DNS만 허용하고 **모든 주소**를 검사한 뒤 socket lookup을 public IP로 pin. 기본 TLS hostname 검증은 유지.
- 토큰은 정확한 Slack origin의 Authorization 헤더로만 전달. 동일 origin/private path redirect 최대 2회, 매 hop DNS 재검증. 외부 redirect 금지. 압축 응답 거부, 4 MiB/10초 제한. MIME은 서버 metadata와 전송 MIME을 모두 검증하며 TXT/CSV의 `application/force-download`만 예외(UTF-8 charset 필수 정책 유지). 이미지/PDF에는 이 예외를 적용하지 않음.
- 운영자는 별도의 **서버 공급** `VisionConfig {apiKey, baseURL, model}`를 주입해야 합니다. 미설정은 `VISION_CONFIG`. DeepSeek/실행 모델이 이미지 입력을 지원한다고 가정하지 않으며 자동 fallback/모델 전환도 없습니다. 테스트 속 endpoint/model 이름은 가짜 transport 데이터일 뿐 실제 지원 증거가 아닙니다.
- Vision endpoint는 HTTPS public DNS/pinned socket, root 또는 `/v1` base URL만 허용. redirect/압축/오류 응답 거부, 요청 6 MiB/응답 64 KiB/30초 제한. parent abort가 실제 HTTP socket을 파괴합니다. native DNS lookup은 취소 API가 없으므로 늦게 끝날 수 있으나 deadline 이후 socket을 열지 않습니다.
- Vision wire에는 질문과 **inline PNG/JPEG bytes**만 전달; Slack token/private download URL/파일명/Slack metadata는 전달하지 않습니다. 도구 없는 별도 system prompt로 관찰/추론/불확실성을 구분. 응답에서 tool calls/refusal/비정상 schema/반사된 key·토큰·private URL/base64 payload를 거부. 정제된 오류 코드만 반환하며 raw provider/Slack 오류를 노출하지 않습니다.
- 이미지 내용을 제3자 Vision provider로 보내므로 배포 전에 해당 채널/조직의 개인정보·데이터 전송 정책과 provider 보관 정책을 승인받아야 합니다.

## 검증 범위

주입된 authorized metadata, synthetic 문서/이미지, mock transport와 loopback socket만 사용. URL/DNS/redirect/MIME/signature/size, Unicode/범위, CSV 수식 비실행, PDF decompression preflight/격리/dependency contract, 이미지 구조·해석 notice, inline wire payload, 응답·중단·timeout 경계를 검사합니다. `.env`/실제 Slack/실제 provider에는 접근하지 않습니다. live 권한 adapter·등록·manifest/config·실제 PDF.js·운영 Vision 모델 검증은 **미완료 통합 작업**입니다.
