import { createDeepSeek } from '@ai-sdk/deepseek';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMainAgent, createMastra, createWebTools } from '../index.js';
import { description } from './agents/main/description.js';
import { instructions } from './agents/main/instructions.js';

function fixtureModel() {
  const fetch = vi.fn(async () => {
    return new Response(JSON.stringify({
      id: 'fixture', created: 0, model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '오프라인 응답' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }), { headers: { 'content-type': 'application/json' } });
  });
  return { model: createDeepSeek({ apiKey: 'synthetic-only', fetch })('deepseek-chat'), fetch };
}

describe('standalone agent and Mastra registration', () => {
  it('registers only the two public web tools and no persistent store/agent memory', async () => {
    const { model, fetch } = fixtureModel();
    const mastra = createMastra({ model });
    const agent = mastra.getAgent('main');
    expect(mastra.getAgentById('my-mastra')).toBe(agent);
    expect(Object.keys(await agent.listTools())).toEqual(['web_fetch', 'web_search']);
    expect(agent.getDescription()).toBe(description);
    expect(await agent.getInstructions()).toBe(instructions);
    expect(await agent.getMemory()).toBeUndefined();
    // Core 1.74 supplies an ephemeral internal store; no database adapter is configured.
    expect(mastra.getStorage()?.id).toBe('in-memory');
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(createWebTools())).toEqual(['web_fetch', 'web_search']);
  });
  it('generates with actual Mastra + DeepSeek SDK over a mocked transport, without credentials', async () => {
    const { model, fetch } = fixtureModel();
    const agent = createMastra({ model }).getAgent('main');
    const result = await agent.generate('안녕', { maxSteps: 2 });
    expect(result.text).toBe('오프라인 응답');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('executes a web tool through the real SDK tool loop with only mocked network', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const message = requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://public-source.org', maxChars: 100 }) } }] }
        : { role: 'assistant', content: '확인한 본문 응답' };
      return new Response(JSON.stringify({
        id: 'fixture', created: 0, model: 'deepseek-chat',
        choices: [{ index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const connector = vi.fn(async () => {
      const stream = new PassThrough() as unknown as IncomingMessage;
      stream.statusCode = 200; stream.headers = { 'content-type': 'text/plain' };
      queueMicrotask(() => (stream as unknown as PassThrough).end('Public fixture text'));
      return stream;
    });
    const model = createDeepSeek({ apiKey: 'synthetic-only', fetch })('deepseek-chat');
    const agent = createMastra({ model, webOptions: { network: { resolver: async () => [{ address: '93.184.216.34', family: 4 }], connector } } }).getAgent('main');
    const result = await agent.generate('공개 본문 읽어줘', { maxSteps: 3 });
    expect(result.text).toBe('확인한 본문 응답');
    expect(connector).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests[1])).toContain('fetched_text');
    const tools = requests[0]?.tools as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(['web_fetch', 'web_search']);
  });
  it('separates generic instructions, description and tools without internal resources', async () => {
    const { model } = fixtureModel();
    expect(createMainAgent(model).id).toBe('my-mastra');
    expect(instructions).toContain('신뢰할 수 없는 외부 데이터');
    expect(instructions).toContain('search_snippets');
    expect(instructions).toContain('fetched_text');
    expect(instructions).toContain('우회');
    expect(instructions).not.toMatch(/shookie|Slack|PostHog|GitHub/iu);
  });
  it('forces optional framework telemetry off at construction, not at import', () => {
    const previous = process.env.MASTRA_TELEMETRY_DISABLED;
    try {
      process.env.MASTRA_TELEMETRY_DISABLED = 'false';
      createMainAgent(fixtureModel().model);
      expect(process.env.MASTRA_TELEMETRY_DISABLED).toBe('true');
    } finally {
      if (previous === undefined) delete process.env.MASTRA_TELEMETRY_DISABLED;
      else process.env.MASTRA_TELEMETRY_DISABLED = previous;
    }
  });
  it('builds the default keyed provider lazily without making a request', async () => {
    const registry = createMastra({ config: { deepseekApiKey: 'synthetic-only', model: 'deepseek-chat', exaApiKey: 'optional-synthetic' } });
    const tools = await registry.getAgent('main').listTools();
    expect(tools.web_search?.description).toContain('REST API');
  });
});
