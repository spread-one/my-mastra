import { expect, it } from 'vitest';
import { sanitizeSlackDataMessage } from './format.js';
it('sanitizes credential/private URL values before encoding without corrupting quoted source metadata JSON', () => {
  const token = 'private"token\\escaped';
  const source = { source: 'slack_event', ts: '100.0', author: { userId: 'U1' },
    text: `look at https://files.slack.com/files-pri/T-F/download\"suffix then ${token}`,
    attachments: [{ fileId: 'FGOOD', name: `https://files.slack.com/files-pri/T-F/evil\"name ${token}` }] };
  const encoded = sanitizeSlackDataMessage(JSON.stringify(source), [token]);
  const parsed = JSON.parse(encoded);
  expect(parsed.author).toEqual({ userId: 'U1' }); expect(parsed.attachments[0].fileId).toBe('FGOOD');
  expect(parsed.text).not.toContain(token); expect(parsed.attachments[0].name).not.toContain(token);
  expect(encoded).not.toContain('files-pri');
});
