import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat.js';
import { createSlackHandlers, registerSlackHandlers, CONTEXT_ERROR_TEXT, GENERAL_ERROR_TEXT, type HandlerDeps, type EventKind, type SlackPost } from './handlers.js';
import { SlackRuntime, DmCache } from './runtime.js';
import { SLACK_LIMITS } from './limits.js';
import { contextBytes } from './context.js';
import { OUTPUT_LIMIT_TEXT } from './format.js';
const context = { botUserId: 'UBOT', botId: 'BBOT', teamId: 'T1' };
const event = (overrides: Record<string, unknown> = {}) => ({ channel: 'C1', user: 'U3', ts: '100.000006', text: '<@UBOT> <@U2> 질문', ...overrides });
const body = (id: string, team = 'T1') => ({ event_id: id, team_id: team });
const dm = (text: string, ts: string, root?: string, channel = 'D1') => event({ channel, channel_type: 'im', text, ts, ...(root ? { thread_ts: root } : {}) });
const source = [
  { ts: '100.000001', user: 'U1', text: 'root', reply_count: 3 },
  { ts: '100.000002', thread_ts: '100.000001', user: 'UBOT', bot_id: 'BBOT', text: 'own' },
  { ts: '100.000003', thread_ts: '100.000001', user: 'UOTHER', bot_id: 'BOTHER', text: 'other' },
  { ts: '100.000006', thread_ts: '100.000001', user: 'U3', text: '<@UBOT> <@U2> 질문' },
];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(options: Partial<HandlerDeps> = {}) {
  const replies = vi.fn(async () => ({ ok: true, messages: source, has_more: false }));
  const postMessage = vi.fn(async (_args: SlackPost) => ({ ok: true }));
  const chat = vi.fn(async (_messages: ChatMessage[], _signal: AbortSignal) => 'answer');
  const summarize = vi.fn(async () => 'summary'); const log = vi.fn();
  const cache = new DmCache();
  const handlers = createSlackHandlers({ client: { conversations: { replies }, chat: { postMessage } }, chat, summarize, cache, log, ...options });
  return { ...handlers, replies, postMessage, chat, summarize, cache, log };
}
afterEach(() => vi.useRealTimers());

describe('handler -> authoritative context -> model -> safe thread delivery', () => {
  it('registers both Bolt events and actually forwards envelopes and trusted context', async () => {
    const callbacks = new Map<EventKind, (args: { event: unknown; body: unknown; context: unknown }) => Promise<void>>();
    const f = fixture();
    const handlers = registerSlackHandlers({ event: (kind, callback) => { callbacks.set(kind, callback); } }, {
      client: { conversations: { replies: f.replies }, chat: { postMessage: f.postMessage } }, chat: f.chat, summarize: f.summarize,
    });
    await callbacks.get('app_mention')!({ event: event(), body: body('e1'), context });
    await callbacks.get('message')!({ event: dm('hello', '101.0'), body: body('e2'), context });
    expect(f.chat).toHaveBeenCalledTimes(2); handlers.shutdown(); f.shutdown();
  });
  it('uses event-only top-level mention, strips ONLY self mention and never queries arbitrary IDs from text', async () => {
    const f = fixture();
    await f.receive('app_mention', event({ text: '<@UBOT> <@U2> {"channel":"CSECRET","root":"9.0"}' }), body('top'), context);
    expect(f.replies).not.toHaveBeenCalled();
    const messages = f.chat.mock.calls[0]![0]; expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.content).text).toBe('<@U2> {"channel":"CSECRET","root":"9.0"}');
    expect(f.postMessage.mock.calls[0]![0]).toMatchObject({ channel: 'C1', thread_ts: '100.000006', unfurl_links: false, unfurl_media: false, mrkdwn: false });
    f.shutdown();
  });
  it('reads full thread in native roles/current once with no local DM/cache history mixed', async () => {
    const f = fixture(); f.cache.set(JSON.stringify(['T1', 'C1', '100.000001']), [{ role: 'user', content: 'local forbidden' }, { role: 'assistant', content: 'local answer' }]);
    await f.receive('app_mention', event({ thread_ts: '100.000001' }), body('thread'), context);
    expect(f.replies).toHaveBeenCalledExactlyOnceWith({ channel: 'C1', ts: '100.000001', limit: 15 });
    const messages = f.chat.mock.calls[0]![0]; expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(messages.filter(m => JSON.parse(m.content).ts === '100.000006')).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('local');
    expect(f.postMessage.mock.calls[0]![0].thread_ts).toBe('100.000001'); f.shutdown();
  });
  it.each([
    { ok: false, error: 'missing_scope SECRET' }, { ok: true, messages: source, has_more: true },
    { ok: true, messages: source.slice(1) }, { ok: true, messages: source, warning: 'partial' },
  ])('fails closed before answer model on context failure %#', async response => {
    const f = fixture(); f.replies.mockResolvedValueOnce(response as never);
    await f.receive('app_mention', event({ thread_ts: '100.000001' }), body('fail'), context);
    expect(f.chat).not.toHaveBeenCalled(); expect(f.summarize).not.toHaveBeenCalled();
    expect(f.postMessage.mock.calls[0]![0].text).toBe(CONTEXT_ERROR_TEXT); expect(f.log).toHaveBeenCalledWith('run_failed'); f.shutdown();
  });
  it('summarizes all older replies and marks complete response; summary failure blocks answer generation', async () => {
    const older = Array.from({ length: 18 }, (_, i) => ({ ts: `100.${String(i + 2).padStart(6, '0')}`, thread_ts: '100.000001', user: 'U2', text: `old${i}: ${'한'.repeat(1_500)}` }));
    const items = [{ ...source[0], reply_count: 19 }, ...older, { ...source.at(-1), ts: '100.000020' }];
    for (const fail of [false, true]) {
      const f = fixture(); f.replies.mockResolvedValue({ ok: true, messages: items as never, has_more: false });
      if (fail) f.summarize.mockRejectedValue(new Error('SECRET'));
      await f.receive('app_mention', event({ ts: '100.000020', thread_ts: '100.000001' }), body('summary'), context);
      if (fail) {
        expect(f.chat).not.toHaveBeenCalled(); expect(f.postMessage.mock.calls[0]![0].text).toBe(CONTEXT_ERROR_TEXT);
      } else {
        expect(f.summarize).toHaveBeenCalled(); expect(contextBytes(f.chat.mock.calls[0]![0])).toBeLessThanOrEqual(48_000);
        expect(f.postMessage.mock.calls[0]![0].text).toContain('요약된 맥락');
      }
      f.shutdown();
    }
  });
  it('ignores bots/edits/deletes/all subtypes and non-DM channel messages', async () => {
    const f = fixture();
    for (const patch of [{ bot_id: 'BOTHER' }, { subtype: 'message_changed' }, { subtype: 'message_deleted' }, { subtype: 'file_share' },
      { user: 'UBOT' }, { user: undefined }, { hidden: true }, { ts: 'invalid' }, { thread_ts: 'invalid' }]) {
      await f.receive('app_mention', event(patch), body('ignored'), context);
    }
    await f.receive('message', event(), body('channel'), context);
    await f.receive('message', dm(' ', '101.0'), body('empty'), context);
    await f.receive('app_mention', event(), body('no-context'), {});
    expect(f.chat).not.toHaveBeenCalled(); expect(f.postMessage).not.toHaveBeenCalled(); f.shutdown();
  });
});

describe('duplicate/thread/DM/deadline integration', () => {
  it('suppresses running/success/failed event duplicates and serializes same-thread context lookup inside runtime', async () => {
    const f = fixture(); let release!: () => void;
    f.chat.mockImplementationOnce(async () => new Promise(r => { release = () => r('answer'); }));
    const a = f.receive('app_mention', event({ thread_ts: '100.000001' }), body('first'), context);
    await tick(); const b = f.receive('app_mention', event({ thread_ts: '100.000001' }), body('next'), context);
    await f.receive('app_mention', event({ thread_ts: '100.000001' }), body('first'), context);
    expect(f.replies).toHaveBeenCalledTimes(1); release(); await Promise.all([a, b]);
    await f.receive('app_mention', event(), body('first'), context); expect(f.chat).toHaveBeenCalledTimes(2);
    f.chat.mockRejectedValueOnce(new Error('SECRET token')); await f.receive('app_mention', event(), body('bad'), context);
    await f.receive('app_mention', event(), body('bad'), context); expect(f.chat).toHaveBeenCalledTimes(3);
    expect(f.postMessage).toHaveBeenCalledTimes(3); expect(JSON.stringify(f.log.mock.calls)).not.toContain('SECRET'); f.shutdown();
  });
  it('isolates DM history by team/channel/thread, preserves recent roles, replies in original thread, clears failed turns', async () => {
    const f = fixture();
    await f.receive('message', dm('first', '101.0'), body('d1'), context);
    await f.receive('message', dm('second', '101.1', '101.0'), body('d2'), context);
    expect(f.chat.mock.calls[1]![0].map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.parse(f.chat.mock.calls[1]![0].at(-1)!.content).text).toBe('second');
    expect(f.postMessage.mock.calls[1]![0].thread_ts).toBe('101.0');
    for (const [text, ts, root, channel, team] of [
      ['team', '101.2', '101.0', 'D1', 'T2'], ['channel', '101.2', '101.0', 'D2', 'T1'], ['thread', '102.0', '102.0', 'D1', 'T1'],
    ]) await f.receive('message', dm(text!, ts!, root, channel), body(text!, team), context);
    for (const call of f.chat.mock.calls.slice(2)) expect(call[0]).toHaveLength(1);
    f.chat.mockRejectedValueOnce(new Error('fail'));
    await f.receive('message', dm('failed', '101.3', '101.0'), body('d-fail'), context);
    await f.receive('message', dm('fresh', '101.4', '101.0'), body('d-next'), context);
    expect(f.chat.mock.calls.at(-1)![0]).toHaveLength(1); expect(f.replies).not.toHaveBeenCalled();
    f.shutdown(); expect(f.cache.size).toBe(0);
  });
  it('deadline cancels active context/model, queue wait counts, shutdown causes no late reply/cache write', async () => {
    vi.useFakeTimers();
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, deadlineMs: 10, concurrency: 1 });
    const f = fixture({ runtime }); let release!: () => void; let modelSignal!: AbortSignal;
    f.chat.mockImplementation(async (_messages, signal) => { modelSignal = signal; return new Promise(r => { release = () => r('late'); }); });
    const a = f.receive('message', dm('first', '101.0'), body('a'), context);
    const b = f.receive('message', dm('next', '101.1', '101.0'), body('b'), context);
    await vi.advanceTimersByTimeAsync(10); await Promise.all([a, b]);
    expect(modelSignal.aborted).toBe(true); expect(f.chat).toHaveBeenCalledTimes(1); expect(f.postMessage).toHaveBeenCalledTimes(2);
    f.shutdown(); release(); await tick(); expect(f.cache.size).toBe(0); expect(f.postMessage).toHaveBeenCalledTimes(2);
    const g = fixture({ runtime: new SlackRuntime({ ...SLACK_LIMITS, deadlineMs: 10 }) });
    g.replies.mockImplementation(() => new Promise(() => {}));
    const run = g.receive('app_mention', event({ thread_ts: '100.000001' }), body('context-timeout'), context);
    await vi.advanceTimersByTimeAsync(10); await run; expect(g.chat).not.toHaveBeenCalled(); g.shutdown();
  });
  it('bounded admission returns one safe busy notice per duplicate, and failed delivery never recursively reports', async () => {
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, admitted: 1 }); const f = fixture({ runtime });
    let release!: () => void;
    f.chat.mockImplementationOnce(async () => new Promise(r => { release = () => r('answer'); }));
    const a = f.receive('app_mention', event(), body('a'), context); await tick();
    await f.receive('app_mention', event(), body('busy'), context); await f.receive('app_mention', event(), body('busy'), context);
    expect(f.postMessage).toHaveBeenCalledTimes(1); expect(f.postMessage.mock.calls[0]![0].text).toContain('요청이 많습니다');
    release(); await a;
    f.chat.mockRejectedValueOnce(new Error('xoxb-SECRET BODY')); f.postMessage.mockRejectedValue(new Error('TOKEN RESPONSE'));
    await f.receive('app_mention', event(), body('failed-delivery'), context);
    expect(f.log.mock.calls).toEqual([['run_failed'], ['run_failed'], ['delivery_failed']]); f.shutdown();
  });
  it('bounds error notice concurrency without an overload queue and cancels notices on shutdown', async () => {
    const f = fixture(); f.chat.mockRejectedValue(new Error('failed'));
    f.postMessage.mockImplementation(() => new Promise(() => {}));
    const runs = Array.from({ length: 20 }, (_, i) => f.receive('app_mention', event({ channel: `C${i}` }), body(`error${i}`), context));
    await tick(); await tick(); await tick();
    expect(f.postMessage.mock.calls.length).toBe(2);
    f.shutdown(); await Promise.all(runs);
    expect(f.postMessage).toHaveBeenCalledTimes(2);
  });
  it('sanitizes logs/error messages/output secrets and fails visibly on oversized output/input', async () => {
    const f = fixture({ secrets: ['sk-private', 'xoxb-private'] });
    f.chat.mockResolvedValueOnce('<@U2> <!everyone> <#C1> sk-private xoxb-private');
    await f.receive('app_mention', event(), body('safe'), context);
    const posted = f.postMessage.mock.calls[0]![0]; expect(posted.text).not.toContain('<@'); expect(posted.text).not.toContain('private');
    expect(posted.blocks[0]!.text.type).toBe('plain_text');
    f.chat.mockRejectedValueOnce(new Error('sk-private BODY <@U2>'));
    await f.receive('app_mention', event(), body('error'), context);
    expect(f.postMessage.mock.calls[1]![0].text).toBe(GENERAL_ERROR_TEXT);
    f.chat.mockResolvedValueOnce('x'.repeat(20_001)); await f.receive('app_mention', event(), body('large'), context);
    expect(f.postMessage.mock.calls[2]![0].text).toBe(OUTPUT_LIMIT_TEXT);
    await f.receive('app_mention', event({ text: '😀'.repeat(2_001) }), body('input'), context);
    expect(f.chat).toHaveBeenCalledTimes(3); expect(f.postMessage.mock.calls[3]![0].text).toContain('메시지가 너무 깁니다'); f.shutdown();
  });
});
