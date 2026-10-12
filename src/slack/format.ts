import { bytes, SLACK_LIMITS as limits } from './limits.js';
import { renderMarkdown } from './markdown.js';

export const OUTPUT_LIMIT_TEXT = '응답이 안전한 Slack 출력 한도를 초과해 게시하지 않았습니다. 더 짧은 답변을 요청해주세요.';
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[비밀 삭제]');
  return safe.replace(/\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/gu, '[Slack 토큰 삭제]');
}

/** Canonical conversation content; never reconstruct it from presentation blocks. */
export function sanitizeSlackSource(text: string, secrets: readonly string[] = []): string {
  return redactSecrets(text, secrets).replace(/https?:\/\/files\.slack\.com\/files-pri\/[^\s"<>]+/giu, '[비공개 첨부 주소 삭제]').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
}

/** Sanitize string VALUES before JSON serialization; escaped quotes/URLs must not break envelopes. */
export function sanitizeSlackDataMessage(content: string, secrets: readonly string[] = []): string {
  try {
    const source = JSON.parse(content) as { source?: unknown };
    if (!source || typeof source.source !== 'string' || !['slack_event', 'slack_thread', 'slack_thread_summary'].includes(source.source)) return sanitizeSlackSource(content, secrets);
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') return sanitizeSlackSource(value, secrets);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    return JSON.stringify(scrub(source));
  } catch { return sanitizeSlackSource(content, secrets); }
}

export function formatSlack(text: string, secrets: readonly string[] = []) {
  const safe = sanitizeSlackSource(text, secrets);
  if (!safe.trim() || safe.length > limits.outputChars || bytes(safe) > limits.outputBytes) throw new Error('SLACK_OUTPUT_LIMIT');
  const { blocks, fallback } = renderMarkdown(safe);
  return {
    text: fallback,
    blocks,
    mrkdwn: false, parse: 'none' as const, link_names: false, unfurl_links: false, unfurl_media: false,
  };
}
