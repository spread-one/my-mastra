import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat.js';
import { createSlackHandlers, CONTEXT_ERROR_TEXT, HISTORY_ERROR_TEXT, HISTORY_SAVE_ERROR_TEXT, type SlackPost } from './handlers.js';
import { contextBytes, eventMessage } from './context.js';
import { openSqliteHistory, HistoryError } from './history/index.js';
import { SlackRuntime } from './runtime.js';
import { SLACK_LIMITS } from './limits.js';

const root = '100.000001', next = '100.000002', key = JSON.stringify(['T1', 'D1', root]);
const body = (event_id = 'event') => ({ team_id: 'T1', event_id });
const context = { botUserId: 'UBOT' }, signal = new AbortController().signal;
const event = (override = {}) => ({ channel: 'D1', channel_type: 'im', user: 'U1', ts: root, text: 'question', ...override });
const candidates = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `FFILE${i}`, name: 'sk'.repeat(256), mimetype: 'sk'.repeat(100) }));
const directories: string[] = [];
const fixturePath = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'revision-history-')); directories.push(dir); return join(dir, 'history.sqlite'); };
afterEach(() => { vi.useRealTimers(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true }); });
const prior: ChatMessage[] = [eventMessage('prior question', 'U1', root), { role: 'assistant', content: '**prior canonical answer**' }];

async function storeFixture() {
  const path = fixturePath(), history = await openSqliteHistory(path);
  await history.set(key, prior, signal);
  return { path, history };
}

describe('final transformed model context stays within whole-JSON 48KB', () => {
  it.each(['message', 'app_mention'] as const)('refuses one redaction-expanded attachment-only %s event before chat', async kind => {
    const chat = vi.fn(async () => 'must not run'), post = vi.fn(async (_args: SlackPost) => ({ ok: true }));
    const handlers = createSlackHandlers({ secrets: ['sk'], chat, summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    await handlers.receive(kind, event({ ...(kind === 'app_mention' ? { channel: 'C1', channel_type: 'channel' } : {}),
      text: '', subtype: 'file_share', files: candidates(10) }), body(), context);
    expect(chat).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0].text).toContain('메시지가 너무 깁니다'); await handlers.shutdown();
  });

  it('sanitizes both history and the entire candidate envelope before pruning complete old pairs, retaining recent pairs under48KB', async () => {
    const { history } = await storeFixture();
    await history.set(key, [eventMessage('sk'.repeat(2000), 'U1', root), { role: 'assistant', content: 'old answer' },
      eventMessage('sk'.repeat(100), 'U1', next), { role: 'assistant', content: 'recent sk answer' }], signal);
    const seen: ChatMessage[][] = [];
    const handlers = createSlackHandlers({ history, secrets: ['sk'], chat: async messages => { seen.push(messages); return 'fresh answer'; }, summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async () => ({ ok: true }) } } });
    await handlers.receive('message', event({ ts: '100.000003', thread_ts: root, text: '', subtype: 'file_share', files: candidates(6) }), body(), context);
    expect(seen).toHaveLength(1); expect(seen[0]).toHaveLength(3);
    expect(contextBytes(seen[0]!)).toBeLessThanOrEqual(48_000);
    expect(JSON.parse(seen[0]![0]!.content).ts).toBe(next); // Whole oldest pair removed, not the current event.
    expect(seen[0]![1]!.content).toBe('recent [비밀 삭제] answer');
    const current = JSON.parse(seen[0]![2]!.content);
    expect(current.attachments).toHaveLength(6); expect(current.attachments[0].name).toBe('[비밀 삭제]'.repeat(256));
    expect(JSON.stringify(seen)).not.toContain('sk');
    const saved = await history.get(key, signal); expect(saved).toHaveLength(4); expect(JSON.stringify(saved)).not.toContain('sk');
    await handlers.shutdown();
  });

  it('checks again after summary/redaction expansion in an authoritative thread, without truncating root/current', async () => {
    const files = candidates(3), current = '100.000006';
    const source = [{ ts: root, user: 'U2', text: 'root', reply_count: 5 },
      ...Array.from({ length: 4 }, (_, i) => ({ ts: `100.00000${i + 2}`, thread_ts: root, user: 'U2', text: 'x'.repeat(10_000) })),
      { ts: current, thread_ts: root, user: 'U1', text: '', subtype: 'file_share', files }];
    const chat = vi.fn(async () => 'must not run'), summarize = vi.fn(async () => 'sk'.repeat(3000)), post = vi.fn(async (_args: SlackPost) => ({ ok: true }));
    const handlers = createSlackHandlers({ secrets: ['sk'], chat, summarize,
      client: { conversations: { replies: async () => ({ ok: true, messages: source }) }, chat: { postMessage: post } } });
    await handlers.receive('app_mention', event({ channel: 'C1', channel_type: 'channel', ts: current, thread_ts: root, text: '', subtype: 'file_share', files }), body(), context);
    expect(summarize).toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled(); expect(post.mock.calls[0]![0].text).toBe(CONTEXT_ERROR_TEXT);
    await handlers.shutdown();
  });
});

describe('confirmed delivery versus SQLite persistence failure', () => {
  it.each(['ordinary', 'stream'] as const)('reports accurate bounded save-failure after confirmed %s delivery, preserves real locked SQLite prior pairs', async mode => {
    const { path, history } = await storeFixture(), blocker = new DatabaseSync(path, { timeout: 0 });
    const posts: SlackPost[] = [], streamCalls: string[] = [], log = vi.fn(), answer = 'accepted answer';
    const chat = vi.fn(async () => answer);
    const handlers = createSlackHandlers({ history, chat, summarize: async () => '', log,
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async args => {
        posts.push(args); if (args.text === answer) blocker.exec('BEGIN IMMEDIATE'); return { ok: true };
      } }, ...(mode === 'stream' ? { apiCall: async (method: string, args: Record<string, unknown>) => {
        streamCalls.push(method); if (method === 'chat.stopStream' && args.text === answer) blocker.exec('BEGIN IMMEDIATE');
        return { ok: true, ts: '200.000001' };
      } } : {}) } });
    try {
      await handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
      expect(chat).toHaveBeenCalledOnce();
      expect(posts.filter(p => p.text === HISTORY_SAVE_ERROR_TEXT)).toHaveLength(1);
      expect(posts.filter(p => p.text === HISTORY_ERROR_TEXT)).toHaveLength(0);
      expect(posts.filter(p => p.text === answer)).toHaveLength(mode === 'ordinary' ? 1 : 0);
      expect(streamCalls).toEqual(mode === 'stream' ? ['chat.startStream', 'chat.stopStream'] : []);
      expect(log.mock.calls).toEqual([['history_save_failed']]);
      await handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
      expect(chat).toHaveBeenCalledOnce(); expect(posts.filter(p => p.text === HISTORY_SAVE_ERROR_TEXT)).toHaveLength(1);
      const row = blocker.prepare('SELECT payload FROM slack_history_entries WHERE key = ?').get(key);
      expect(JSON.parse(row!.payload as string)).toEqual(prior);
      blocker.exec('ROLLBACK'); expect(await history.get(key, signal)).toEqual(prior);
    } finally { blocker.close(); await handlers.shutdown(); }
    const reopened = await openSqliteHistory(path); expect(await reopened.get(key, signal)).toEqual(prior); await reopened.close();
  });

  it.each(['ordinary', 'stream'] as const)('an ambiguous %s final write never causes another answer or a save-failure notice', async mode => {
    const { history } = await storeFixture(), posts: SlackPost[] = [], streamCalls: string[] = [], log = vi.fn();
    const handlers = createSlackHandlers({ history, chat: async () => 'answer', summarize: async () => '', log,
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async args => {
        posts.push(args); throw new Error('SYNTHETIC_PRIVATE_FINAL_FAILURE');
      } }, ...(mode === 'stream' ? { apiCall: async (method: string) => {
        streamCalls.push(method); if (method === 'chat.stopStream') throw new Error('SYNTHETIC_PRIVATE_FINAL_FAILURE');
        return { ok: true, ts: '200.000001' };
      } } : {}) } });
    await handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
    expect(posts).toHaveLength(mode === 'ordinary' ? 1 : 0);
    expect(streamCalls).toEqual(mode === 'stream' ? ['chat.startStream', 'chat.stopStream'] : []);
    expect(JSON.stringify(posts)).not.toContain(HISTORY_SAVE_ERROR_TEXT); expect(JSON.stringify(log.mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
    await handlers.shutdown();
  });

  it('deadline after confirmed delivery prevents late SQLite writes and uses only one separate bounded save warning', async () => {
    vi.useFakeTimers(); const { history } = await storeFixture();
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, deadlineMs: 20 }), posts: SlackPost[] = [];
    let release!: () => void;
    const handlers = createSlackHandlers({ runtime, history: { ...history, set: async (key, messages, requestSignal) => {
      await new Promise<void>(yes => { release = yes; }); requestSignal.throwIfAborted(); await history.set(key, messages, requestSignal);
    } }, chat: async () => 'accepted answer', summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async args => { posts.push(args); return { ok: true }; } } } });
    const run = handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
    await vi.advanceTimersByTimeAsync(1); expect(posts.map(p => p.text)).toEqual(['accepted answer']);
    await vi.advanceTimersByTimeAsync(20); await run;
    expect(posts.map(p => p.text)).toEqual(['accepted answer', HISTORY_SAVE_ERROR_TEXT]);
    expect(runtime.size).toBe(1); release(); await runtime.settled();
    expect(await history.get(key, signal)).toEqual(prior); expect(posts).toHaveLength(2); await handlers.shutdown();
  });

  it('does not retry even an explicit429 on the ancillary save warning or expose its raw error', async () => {
    const { history } = await storeFixture(), posts: SlackPost[] = [], log = vi.fn();
    const handlers = createSlackHandlers({ history: { ...history, set: async () => { throw new HistoryError('DATABASE'); } },
      chat: async () => 'accepted answer', summarize: async () => '', log,
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async args => {
        posts.push(args); if (args.text === HISTORY_SAVE_ERROR_TEXT) throw { code: 'slack_webapi_rate_limited_error', retryAfter: 1, data: 'PRIVATE_RAW_RESPONSE' };
        return { ok: true };
      } } } });
    await handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
    expect(posts.map(p => p.text)).toEqual(['accepted answer', HISTORY_SAVE_ERROR_TEXT]);
    expect(log.mock.calls).toEqual([['history_save_failed'], ['delivery_failed']]);
    expect(await history.get(key, signal)).toEqual(prior); await handlers.shutdown();
  });

  it('a stalled ancillary save warning has a separate5s deadline, no retry/reanswer and no recursive notice', async () => {
    vi.useFakeTimers();
    // Native AbortSignal.timeout does not use Vitest's clock; bridge it to the test clock only.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const { history } = await storeFixture(), posts: SlackPost[] = [], log = vi.fn();
    const handlers = createSlackHandlers({ history: { ...history, set: async () => { throw new HistoryError('DATABASE'); } },
      chat: async () => 'accepted answer', summarize: async () => '', log,
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: async args => {
        posts.push(args); if (args.text === HISTORY_SAVE_ERROR_TEXT) return new Promise(() => {}); return { ok: true };
      } } } });
    try {
      const run = handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
      await vi.advanceTimersByTimeAsync(1); expect(posts.map(p => p.text)).toEqual(['accepted answer', HISTORY_SAVE_ERROR_TEXT]);
      await vi.advanceTimersByTimeAsync(5_000); await run;
      expect(posts).toHaveLength(2); expect(log.mock.calls).toEqual([['history_save_failed'], ['delivery_failed']]);
      expect(await history.get(key, signal)).toEqual(prior);
    } finally { await handlers.shutdown(); timeout.mockRestore(); }
  });

  it('live on-disk corrupted payload fails closed BEFORE chat and does not erase the corrupted record', async () => {
    const { path, history } = await storeFixture(), external = new DatabaseSync(path, { timeout: 0 });
    external.prepare('UPDATE slack_history_entries SET payload = ?, bytes = ? WHERE key = ?').run('private corrupt row', Buffer.byteLength('private corrupt row'), key);
    const chat = vi.fn(async () => 'must not run'), post = vi.fn(async (_args: SlackPost) => ({ ok: true }));
    const handlers = createSlackHandlers({ history, chat, summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    try {
      await handlers.receive('message', event({ ts: next, thread_ts: root }), body(), context);
      expect(chat).not.toHaveBeenCalled(); expect(post.mock.calls[0]![0].text).toBe(HISTORY_ERROR_TEXT);
      expect(external.prepare('SELECT payload FROM slack_history_entries WHERE key = ?').get(key)!.payload).toBe('private corrupt row');
      expect(JSON.stringify(post.mock.calls)).not.toContain('private corrupt row');
    } finally { external.close(); await handlers.shutdown(); }
  });
});
