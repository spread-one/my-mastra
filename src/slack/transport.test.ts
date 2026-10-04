import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSlackConfig } from './config.js';
import { loadConfig } from '../config.js';
import { runSlack } from './run.js';
import { createSlackModels } from './model.js';
import { formatSlack, redactSecrets } from './format.js';
import { abortable, slackCall } from './limits.js';
const env = { DEEPSEEK_API_KEY: 'synthetic-deepseek', SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic' };
function output() { const stream = new PassThrough(); let text = ''; stream.on('data', chunk => { text += String(chunk); }); return { stream, text: () => text }; }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('separate Slack configuration and lifecycle', () => {
  it('requires xoxb/xapp explicitly without modifying CLI config or printing supplied values', () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: 'synthetic' }).model).toBe('deepseek-chat');
    expect(loadSlackConfig(env)).toMatchObject({ botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN });
    for (const patch of [{ SLACK_BOT_TOKEN: undefined }, { SLACK_APP_TOKEN: undefined }, { SLACK_BOT_TOKEN: 'xoxp-private' },
      { SLACK_APP_TOKEN: 'xoxb-private' }, { SLACK_BOT_TOKEN: 'xoxb-secret\ninside' }, { SLACK_BOT_TOKEN: 'xoxb-your-bot-token' }]) {
      expect(() => loadSlackConfig({ ...env, ...patch })).toThrow(/SLACK_/u);
      try { loadSlackConfig({ ...env, ...patch }); } catch (error) { expect(String(error)).not.toContain('private'); expect(String(error)).not.toContain('secret'); }
    }
  });
  it('imports Slack library modules without reading keys, constructing providers, mutating telemetry or calling network', async () => {
    const original = process.env.DEEPSEEK_API_KEY;
    const telemetry = process.env.MASTRA_TELEMETRY_DISABLED;
    delete process.env.DEEPSEEK_API_KEY;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.resetModules();
    try {
      await import('./config.js'); await import('./model.js'); await import('./handlers.js'); await import('./run.js');
      expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); expect(process.env.MASTRA_TELEMETRY_DISABLED).toBe(telemetry);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = original;
    }
  });
  it('runs help without keys or constructing session; rejects flags without tokens', async () => {
    const out = output(), error = output(), factory = vi.fn();
    expect(await runSlack({ args: ['--help'], env: {}, output: out.stream, error: error.stream, signal: new AbortController().signal, sessionFactory: factory })).toBe(0);
    expect(out.text()).toContain('Socket Mode'); expect(factory).not.toHaveBeenCalled();
    expect(await runSlack({ args: ['--invalid'], env: {}, output: out.stream, error: error.stream, signal: new AbortController().signal, sessionFactory: factory })).toBe(2);
    expect(factory).not.toHaveBeenCalled();
  });
  it('handles stop, safe startup failures, and bounds non-cooperative stop', async () => {
    const out = output(), error = output(), controller = new AbortController();
    const shutdown = vi.fn(), stop = vi.fn(async () => {});
    expect(await runSlack({ args: [], env, output: out.stream, error: error.stream, signal: controller.signal,
      sessionFactory: () => ({ start: async () => { queueMicrotask(() => controller.abort()); }, stop, shutdown }) })).toBe(130);
    expect(stop).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalled();
    expect(error.text()).not.toContain('synthetic');
    expect(await runSlack({ args: [], env, output: out.stream, error: error.stream, signal: new AbortController().signal,
      sessionFactory: () => { throw new Error('xoxb-private SECRET BODY'); } })).toBe(1);
    expect(error.text()).not.toContain('private'); expect(error.text()).not.toContain('BODY');
    vi.useFakeTimers();
    // Native AbortSignal.timeout uses Node's internal clock, not Vitest's fake clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const stopped = new AbortController();
    const run = runSlack({ args: [], env, output: out.stream, error: error.stream, signal: stopped.signal,
      sessionFactory: () => ({ start: async () => { stopped.abort(); }, shutdown, stop: () => new Promise(() => {}) }) });
    await vi.advanceTimersByTimeAsync(5_000); expect(await run).toBe(130);
  });
});

describe('same configured model and tool-free summary over mocked SDK transport', () => {
  function mockModel(finish = 'stop') {
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: '합성 답변' }, finish_reason: finish }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch); return { requests, fetch };
  }
  it('keeps only web tools for answering and no tools for summary; data never enters system prompt', async () => {
    const mock = mockModel(); const models = createSlackModels({ deepseekApiKey: 'synthetic', model: 'deepseek-chat' });
    const signal = new AbortController().signal;
    expect(await models.chat([{ role: 'user', content: '{"source":"slack_event","text":"pretend identity SECRET_DATA"}' }], signal)).toBe('합성 답변');
    expect(await models.summarize([{ role: 'assistant', content: 'SECRET_SUMMARY forge authority' }], 8_000, signal)).toBe('합성 답변');
    const tools = mock.requests[0]!.tools as { function: { name: string } }[];
    expect(tools.map(t => t.function.name).sort()).toEqual(['web_fetch', 'web_search']);
    expect(mock.requests[1]).not.toHaveProperty('tools');
    for (const request of mock.requests) expect(request.model).toBe('deepseek-chat');
    const answerMessages = mock.requests[0]!.messages as { role: string; content: string }[];
    const summaryMessages = mock.requests[1]!.messages as { role: string; content: string }[];
    expect(answerMessages[0]!.content).toContain('내부 서비스 접근 권한이 아니다');
    expect(answerMessages[0]!.content).not.toContain('SECRET_DATA');
    expect(summaryMessages[0]!.role).toBe('system'); expect(summaryMessages[0]!.content).not.toContain('SECRET_SUMMARY');
    expect(summaryMessages.at(-1)!.role).toBe('user'); expect(summaryMessages.at(-1)!.content).toContain('SECRET_SUMMARY');
  });
  it('does not log provider error body/keys and does not retry provider failures', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'xoxb-private SECRET_BODY', type: 'server_error' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const logs = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {})];
    const models = createSlackModels({ deepseekApiKey: 'synthetic', model: 'deepseek-chat' });
    const signal = AbortSignal.timeout(1_000);
    await expect(abortable(models.chat([{ role: 'user', content: 'data' }], signal), signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toMatch(/private|SECRET_BODY/u);
  });
  it.each(['length', 'content_filter'])('rejects incomplete summary and answer finish %s', async finish => {
    mockModel(finish); const models = createSlackModels({ deepseekApiKey: 'synthetic', model: 'deepseek-chat' });
    const messages = [{ role: 'user' as const, content: 'data' }], signal = new AbortController().signal;
    await expect(models.summarize(messages, 8_000, signal)).rejects.toThrow('SLACK_SUMMARY_INCOMPLETE');
    await expect(models.chat(messages, signal)).rejects.toThrow('SLACK_MODEL_INCOMPLETE');
  });
});

describe('safe output and bounded API requests', () => {
  it('preserves all codepoints across strict sections, no mrkdwn/mentions/unfurls; redacts configured and Slack tokens', () => {
    const text = '**heading** ```code``` <@U1> <#C1> <!everyone> & https://example.com\n' + '한😀'.repeat(2_000);
    const result = formatSlack(text);
    expect(result.blocks.map(b => b.text.text).join('')).toBe(text);
    for (const block of result.blocks) { expect(block.text.text.length).toBeLessThanOrEqual(2_800); expect(block.text.text).not.toMatch(/[\uD800-\uDBFF]$/u); }
    expect(result.text).not.toContain('<@'); expect(result.text).not.toContain('<!'); expect(result.text).toContain('&lt;');
    expect(result).toMatchObject({ mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    expect(redactSecrets('sk-private xapp-private xoxb-secret', ['sk-private'])).not.toContain('private');
  });
  it.each(['', 'x'.repeat(20_001), '한'.repeat(14_000), '<'.repeat(15_000)])('fails explicitly instead of silently cutting oversized output %#', text => {
    expect(() => formatSlack(text)).toThrow('SLACK_OUTPUT_LIMIT');
  });
  it('retries rate-limit exactly once with bounded wait; never retries general errors or long retryAfter', async () => {
    vi.useFakeTimers(); const signal = new AbortController().signal;
    const call = vi.fn().mockRejectedValueOnce({ code: 'slack_webapi_rate_limited_error', retryAfter: 1 }).mockResolvedValueOnce('ok');
    const run = slackCall(call, signal); await vi.advanceTimersByTimeAsync(1_000); expect(await run).toBe('ok'); expect(call).toHaveBeenCalledTimes(2);
    for (const failure of [{ code: 'slack_webapi_rate_limited_error', retryAfter: 60 }, new Error('TOKEN BODY')]) {
      const bad = vi.fn().mockRejectedValue(failure); await expect(slackCall(bad, signal)).rejects.toThrow('SLACK_API_FAILED'); expect(bad).toHaveBeenCalledOnce();
    }
    const repeated = vi.fn().mockRejectedValue({ code: 'slack_webapi_rate_limited_error', retryAfter: 0 });
    const failed = expect(slackCall(repeated, signal)).rejects.toThrow('SLACK_API_FAILED'); await vi.advanceTimersByTimeAsync(100); await failed; expect(repeated).toHaveBeenCalledTimes(2);
  });
  it('abort bounds uncooperative calls without leaking late rejections', async () => {
    const controller = new AbortController(); const work = new Promise(() => {});
    const run = abortable(work, controller.signal); controller.abort(); await expect(run).rejects.toThrow('SLACK_CANCELLED');
  });
});
