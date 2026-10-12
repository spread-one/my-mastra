import { createDeepSeek } from '@ai-sdk/deepseek';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createWebTools } from './tools.js';
import { ContentStore } from './content.js';

// Actual Agent.generate -> tool.execute(input, context), not a hand-built context mock.
describe('Mastra continuation context integration', () => {
  it('forwards trusted RequestContext through fetch/read/find in a real SDK loop', async () => {
    const body = 'x'.repeat(150) + '\nMARKER😀';
    const connector = vi.fn(async () => {
      const stream = new PassThrough() as unknown as IncomingMessage;
      stream.statusCode = 200; stream.headers = { 'content-type': 'text/plain' };
      queueMicrotask(() => (stream as unknown as PassThrough).end(body));
      return stream;
    });
    const results: any[] = [];
    let step = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const toolMessages = request.messages.filter((m: any) => m.role === 'tool');
      if (toolMessages.length) results.push(JSON.parse(toolMessages.at(-1).content));
      const first = results[0];
      const calls = [
        ['web_fetch', { url: 'https://source.org', maxChars: 100 }],
        ['web_read_more', { contentId: first?.contentId, offset: first?.nextOffset }],
        ['web_find_in_content', { contentId: first?.contentId, literal: 'MARKER' }],
      ] as const;
      const call = calls[step++];
      const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: `call${step}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: 'assistant', content: 'done' };
      return new Response(JSON.stringify({ id: 'fixture', created: 0, model: 'deepseek-chat', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), { headers: { 'content-type': 'application/json' } });
    });
    const agent = new Agent({ id: 'web-context-test', name: 'Web context test', instructions: 'Use web tools.', model: createDeepSeek({ apiKey: 'synthetic', fetch })('deepseek-chat'), tools: createWebTools({ enableContinuation: true, contentStore: new ContentStore(), network: { resolver: async () => [{ address: '93.184.216.34', family: 4 }], connector } }) });
    const requestContext = new RequestContext<unknown>(Object.entries({ teamId: 'T', userId: 'U', channel: 'C', threadTs: '1.1' }));
    expect((await agent.generate('read', { requestContext, maxSteps: 5 })).text).toBe('done');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ ok: true, storage: 'available', nextOffset: 100 });
    expect(results[1]).toMatchObject({ ok: true, text: body.slice(100), complete: true });
    expect(results[2]).toMatchObject({ ok: true, resultKind: 'literal_matches', matches: [{ offset: 151, endOffset: 157 }] });
    expect(connector).toHaveBeenCalledTimes(1);
  });
});
