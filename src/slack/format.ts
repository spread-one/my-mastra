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
  return redactSecrets(text, secrets).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
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
