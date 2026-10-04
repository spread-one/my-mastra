import { bytes, SLACK_LIMITS as limits } from './limits.js';

export const OUTPUT_LIMIT_TEXT = '응답이 안전한 Slack 출력 한도를 초과해 게시하지 않았습니다. 더 짧은 답변을 요청해주세요.';
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[비밀 삭제]');
  return safe.replace(/\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/gu, '[Slack 토큰 삭제]');
}

/** Plain-text sections preserve Markdown literally, not Slack control syntax. No mentions or auto-links. */
export function formatSlack(text: string, secrets: readonly string[] = []) {
  const safe = redactSecrets(text, secrets).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
  if (!safe.trim() || safe.length > limits.outputChars || bytes(safe) > limits.outputBytes) throw new Error('SLACK_OUTPUT_LIMIT');
  const parts: string[] = [];
  let part = '';
  for (const character of safe) {
    if (part.length + character.length > limits.sectionChars) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  if (parts.length > limits.blocks) throw new Error('SLACK_OUTPUT_LIMIT');
  // Escape fallback too: mrkdwn:false alone is not sufficient for all Slack angle-bracket syntax.
  const fallback = safe.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  if (fallback.length > 39_000) throw new Error('SLACK_OUTPUT_LIMIT');
  return {
    text: fallback,
    blocks: parts.map(text => ({ type: 'section' as const, text: { type: 'plain_text' as const, text, emoji: false } })),
    mrkdwn: false, parse: 'none' as const, link_names: false, unfurl_links: false, unfurl_media: false,
  };
}
