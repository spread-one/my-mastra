import { createDeepSeek } from '@ai-sdk/deepseek';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { createChat } from './chat.js';
import { ContentStore } from './tools/web/content.js';

it('standalone createChat registers continuation, reuses its session scope, and isolates another CLI session without Slack authority', async () => {
  const results: any[] = [];
  let contentId: string | undefined, step = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.tools.map((t: any) => t.function.name).sort()).toEqual(['web_fetch', 'web_find_in_content', 'web_read_more', 'web_search']);
    const last = body.messages.filter((m: any) => m.role === 'tool').at(-1);
    if (last) { const result = JSON.parse(last.content); results.push(result); if (result.contentId) contentId = result.contentId; }
    const calls = [ ['web_fetch', { url: 'https://public-source.org', maxChars: 100 }], null,
      ['web_read_more', { contentId, offset: 100 }], null,
      ['web_read_more', { contentId, offset: 100 }], null ];
    const call = calls[step++];
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ id: 'test', created: 0, model: 'deepseek-chat', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }), { headers: { 'content-type': 'application/json' } });
  };
  const model = createDeepSeek({ apiKey: 'synthetic', fetch })('deepseek-chat');
  const webOptions = { contentStore: new ContentStore(), network: { resolver: async () => [{ address: '93.184.216.34', family: 4 as const }], connector: async () => {
    const response = new PassThrough() as unknown as IncomingMessage; response.statusCode = 200; response.headers = { 'content-type': 'text/plain' };
    queueMicrotask(() => (response as unknown as PassThrough).end('x'.repeat(150) + 'CLI marker')); return response;
  } } };
  const config = { deepseekApiKey: 'synthetic', model: 'deepseek-chat' }, signal = new AbortController().signal;
  const chat = createChat(config, { model, webOptions });
  expect(await chat([{ role: 'user', content: 'read' }], signal)).toBe('done');
  expect(await chat([{ role: 'user', content: 'continue' }], signal)).toBe('done');
  const otherSession = createChat(config, { model, webOptions });
  expect(await otherSession([{ role: 'user', content: 'foreign continuation' }], signal)).toBe('done');
  expect(results[0]).toMatchObject({ ok: true, storage: 'available' });
  expect(results[1]).toMatchObject({ ok: true, text: 'x'.repeat(50) + 'CLI marker' });
  expect(results[2]).toMatchObject({ ok: false, error: { code: 'CONTENT_UNAVAILABLE' } });
});
