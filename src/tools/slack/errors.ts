import type { ReadResult } from "./schemas.js";
export const readLimits = { pageSize: 15, maxPages: 4, maxPageBytes: 24_000 };
export const failure = (status: ReadResult["status"], message: string): ReadResult => ({
  status, message, messages: [], page: 0, nextCursor: null, complete: false, truncated: false, limits: readLimits,
});
/** Sanitized public bridge errors: no raw Slack response, auth/action token, headers or stack details. */
export class SlackReadAccessError extends Error {
  constructor(readonly result: ReadResult) { super(result.message); }
  get status() { return this.result.status; }
}
export function deny(): never { throw new SlackReadAccessError(failure("access_denied", "요청자·워크스페이스·대상 채널의 권한을 확인하지 못했습니다. 타 채널은 비공유 공개 채널만 지원하며 전체 스레드는 요청자 membership도 필요합니다.")); }
export function invalid(): never { throw new SlackReadAccessError(failure("invalid_target", "유효한 대상 또는 반환된 불투명 페이지 커서를 지정해주세요.")); }
export function unavailable(): never { throw new SlackReadAccessError(failure("unavailable", "Slack 결과를 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.")); }
export function check(response: { ok?: boolean; error?: string }) {
  if (response.ok && !response.error) return;
  // Keep only the error code internally, never the original response/credential-bearing exception.
  throw new SlackReadAccessError(errorResult({ data: { error: response.error } }));
}
/** Authorization must never accept warning-bearing partial responses. */
export function checkAuthorization(response: { ok?: boolean; error?: string; warning?: string; response_metadata?: { warnings?: string[] } }) {
  check(response);
  if (response.warning || response.response_metadata?.warnings?.length) unavailable();
}
export function errorResult(error: unknown): ReadResult {
  if (error instanceof SlackReadAccessError) return error.result;
  const e = error as { code?: string; statusCode?: number; retryAfter?: number; data?: { error?: string } } | null;
  const code = e?.data?.error;
  if (e?.statusCode === 429 || e?.code === "slack_webapi_rate_limited_error" || code === "ratelimited" || code === "rate_limited") {
    const result = failure("rate_limited", "Slack 호출 한도에 도달했습니다. 잠시 후 다시 시도해주세요. 자동 재시도하지 않았습니다.");
    if (typeof e?.retryAfter === "number" && Number.isFinite(e.retryAfter) && e.retryAfter > 0) result.retryAfterSeconds = e.retryAfter;
    return result;
  }
  if (["not_allowed_token_type", "method_not_supported_for_channel_type", "feature_not_enabled"].includes(code ?? "")) {
    return failure("unsupported", "현재 bot token/워크스페이스에서 이 Slack API를 지원하지 않습니다. 관리자에게 AI/Real-time Search 기능 설정을 확인해주세요. 다른 자격 증명이나 스캔으로 우회하지 않았습니다.");
  }
  if (code === "invalid_action_token") return failure("unsupported", "Slack 검색 action_token이 유효하지 않거나 만료되었습니다. 새 멘션에서 다시 요청해주세요. 관리자에게 event action_token 수신 설정을 확인해주세요.");
  if (["missing_scope", "not_in_channel", "channel_not_found", "context_channel_not_found", "no_permission", "access_denied", "invalid_auth", "not_authed"].includes(code ?? "")) {
    return failure("access_denied", "Slack 권한을 확인하지 못했습니다. 관리자에게 대상 채널의 bot 읽기 권한/참여와 검색용 search:read.public 권한을 확인해주세요. 자동 가입이나 다른 토큰으로 우회하지 않습니다.");
  }
  if (["thread_not_found", "invalid_ts", "invalid_cursor"].includes(code ?? "")) return failure("invalid_target", "대상 메시지 또는 페이지가 유효하지 않습니다. 대상 채널과 반환된 커서를 확인해주세요.");
  return failure("unavailable", "Slack 조회를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.");
}
