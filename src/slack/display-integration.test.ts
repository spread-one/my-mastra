import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSlackReadClient } from '../tools/slack/transport.js';
import { createSlackRuntimeTools } from './tools.js';
import { createSlackHandlers } from './handlers.js';
import { createSlackInvocationContext } from './request.js';
import { contextBytes } from './context.js';
import { slackInstructions, summaryInstructions } from './instructions.js';
import { enrichAuthors, displayLimits } from '../tools/slack/display.js';
import type { ChatMessage } from '../chat.js';

const root = '1700000000.000001', child = '1700000000.000002', token = 'SYNTHETIC_ACTION';
const config = { botToken: 'xoxb-synthetic', appToken: 'xapp-synthetic', deepseekApiKey: 'PRIVATE_KEY', model: 'deepseek-chat' };
const source = [
  { ts: root, user: 'U2', text: '결정 원문', reply_count: 3 },
  { ts: child, thread_ts: root, user: 'UBOT', bot_id: 'BBOT', text: '검토 응답' },
  { ts: '1700000000.000003', thread_ts: root, bot_id: 'BOTHER', text: '추가 의견' },
  { ts: '1700000000.000004', thread_ts: root, user: 'U1', text: '<@UBOT> 결정 요약' },
];
function fixture(options: { denied?: boolean; missing?: boolean; hostile?: boolean; large?: boolean; many?: boolean } = {}) {
  const calls: string[] = [];
  const names = vi.fn(() => { throw new Error('must not execute metadata'); });
  const client = createSlackReadClient({ token: config.botToken }, { adapter: async request => {
    expect(request.headers.Authorization).toBe(`Bearer ${config.botToken}`);
    expect(request.signal).toBeDefined();
    const method = request.url!.split('/').at(-1)!; calls.push(method);
    const args = new URLSearchParams(String(request.data));
    let data: unknown;
    if (method === 'auth.test') data = { ok: true, team_id: 'T1', bot_id: 'BBOT', url: 'https://synthetic.slack.com/' };
    else if (method === 'conversations.info') data = { ok: true, channel: { id: args.get('channel'), name: '의사결정', context_team_id: 'T1', is_channel: true, is_group: false, is_private: false } };
    else if (method === 'conversations.members') data = { ok: true, members: options.denied ? [] : ['U1'] };
    else if (method === 'users.info') {
      const id = args.get('user');
      const profile = options.hostile ? Object.defineProperty({}, 'display_name', { get: names }) : { display_name: id === 'UBOT' ? '검증 봇' : `김민수 ${config.deepseekApiKey} ${token}`, email: 'never@example.org' };
      data = options.missing ? { ok: false, error: 'missing_scope' } : { ok: true, user: { id, profile } };
    } else if (method === 'bots.info') data = { ok: true, bot: { id: args.get('bot'), name: '알림 봇' } };
    else if (method === 'assistant.search.context') data = { ok: true, results: { messages: [{ channel_id: 'C2', team_id: 'T1', message_ts: root, content: options.large ? '😀"\\'.repeat(30000) : '결정 검색', author_user_id: 'U2', is_author_bot: false,
      context_messages: { after: [{ ts: child, text: '응답 검색', bot_id: 'BOTHER' }] } }] } };
    else data = { ok: true, messages: options.many ? Array.from({ length: 15 }, (_, i) => ({ ts: `1700000000.${String(i + 1).padStart(6, '0')}`, user: `U${i + 1}`, text: '원문' })) : source.map(m => ({ ...m, ...(options.large ? { text: '😀"\\'.repeat(3000) } : {}) })) };
    return { config: request, request: {}, status: 200, statusText: 'OK', headers: {}, data };
  } });
  return { client, calls, names };
}
const invocation = () => createSlackInvocationContext({ teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: root, requestId: 'e1', actionToken: token }, new AbortController().signal);
afterEach(() => vi.useRealTimers());

describe('human-readable Slack registered runtime integration (synthetic SDK, no live services)', () => {
  it.each(['slack_read_channel', 'slack_read_thread', 'slack_search'] as const)('enriches %s with same bot SDK after access; final escaped/redacted JSON fits', async name => {
    const f = fixture({ large: true });
    const tools = createSlackRuntimeTools(config, f.client);
    const input = name === 'slack_read_thread' ? { channel: 'C2', ts: root } : name === 'slack_search' ? { query: '결정' } : {};
    const result: any = await tools[name]!.execute!(input as never, { requestContext: invocation() } as never);
    expect(result.status).toBe('ok');
    expect(result.messages[0].channelName).toBe('의사결정');
    expect(result.messages[0].author.displayName).toContain('김민수');
    expect(result.messages[0].author.displayName).toContain('[비밀 삭제]');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_KEY|SYNTHETIC_ACTION|never@example/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(result.limits.maxPageBytes);
    expect(f.calls.indexOf('users.info')).toBeGreaterThan(f.calls.indexOf('conversations.members'));
    expect(f.calls.filter(m => m === 'bots.info')).toHaveLength(1);
    expect(f.calls.filter(m => m === 'users.info')).toHaveLength(name === 'slack_search' ? 1 : 3);
  });
  it.each([{ missing: true }, { hostile: true }])('missing scopes/hostile optional profile do not fail registered reading %#', async options => {
    const f = fixture(options), tools = createSlackRuntimeTools(config, f.client);
    const result: any = await tools.slack_read_channel!.execute!({}, { requestContext: invocation() } as never);
    expect(result.status).toBe('ok'); expect(result.messages[0].author.displayName).toBeUndefined();
    expect(f.names).not.toHaveBeenCalled();
  });
  it('registered channel reading caps lookup count and returns generic metadata on a batch deadline', async () => {
    const f = fixture({ many: true }), tools = createSlackRuntimeTools(config, f.client);
    const result: any = await tools.slack_read_channel!.execute!({}, { requestContext: invocation() } as never);
    expect(result.status).toBe('ok'); expect(f.calls.filter(m => m === 'users.info')).toHaveLength(8);
    vi.useFakeTimers();
    const releases: Array<(value: any) => void> = [];
    f.client.users!.info = vi.fn(() => new Promise(resolve => releases.push(resolve))) as never;
    const pending = tools.slack_read_channel!.execute!({}, { requestContext: invocation() } as never);
    await vi.advanceTimersByTimeAsync(800);
    const timed: any = await pending;
    expect(timed.status).toBe('ok'); expect(releases).toHaveLength(2);
    expect(timed.messages.every((m: any) => !m.author.displayName)).toBe(true);
    for (const release of releases) release({ ok: false, error: 'late' });
    await vi.advanceTimersByTimeAsync(0);
  });
  it('never enriches when live origin access is denied', async () => {
    const f = fixture({ denied: true }), tools = createSlackRuntimeTools(config, f.client);
    const result: any = await tools.slack_read_thread!.execute!({ channel: 'C2', ts: root }, { requestContext: invocation() } as never);
    expect(result.status).toBe('access_denied'); expect(f.calls).not.toContain('users.info'); expect(f.calls).not.toContain('bots.info');
  });
  it('enriches automatic authoritative channel thread in native roles, preserves IDs/raw text, counts final JSON and delivers one answer', async () => {
    const f = fixture(), chat = vi.fn(async (_messages: ChatMessage[]) => '**요약**');
    const post = vi.fn(async () => ({ ok: true }));
    const handlers = createSlackHandlers({ readClient: f.client, secrets: [config.deepseekApiKey], chat, summarize: async () => '요약', client: { chat: { postMessage: post }, conversations: { replies: async () => { throw new Error('raw read'); } } } });
    await handlers.receive('app_mention', { channel: 'C1', user: 'U1', ts: source[3]!.ts, thread_ts: root, text: source[3]!.text, action_token: token }, { event_id: 'auto1', team_id: 'T1' }, { botUserId: 'UBOT', botId: 'BBOT' });
    expect(chat).toHaveBeenCalledOnce();
    const messages = chat.mock.calls[0]![0];
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    const parsed = messages.map(m => JSON.parse(m.content));
    expect(parsed[1].author).toMatchObject({ userId: 'UBOT', botId: 'BBOT', displayName: '검증 봇' });
    expect(parsed[2].author.displayName).toBe('알림 봇');
    expect(parsed[0].channelName).toBe('의사결정');
    expect(parsed[0].text).toBe('결정 원문');
    expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_KEY|SYNTHETIC_ACTION|never@example/);
    expect(contextBytes(messages)).toBeLessThanOrEqual(48000);
    expect(post).toHaveBeenCalledOnce(); await handlers.shutdown();
  });
  it('preserves event-only delivery when optional live display access is unavailable', async () => {
    const f = fixture({ denied: true }), chat = vi.fn(async () => '정상 응답');
    const post = vi.fn(async () => ({ ok: true }));
    const handlers = createSlackHandlers({ readClient: f.client, chat, summarize: async () => '요약', client: { chat: { postMessage: post }, conversations: { replies: async () => ({}) } } });
    await handlers.receive('app_mention', { channel: 'C1', user: 'U1', ts: root, text: '<@UBOT> 질문' }, { event_id: 'event-only', team_id: 'T1' }, { botUserId: 'UBOT', botId: 'BBOT' });
    expect(chat).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
    expect(f.calls).not.toContain('users.info'); await handlers.shutdown();
  });
  it('policies require normal named summaries without hiding truthful limitations or changing renderer syntax', () => {
    expect(slackInstructions).toContain('author.displayName'); expect(slackInstructions).toContain('명시적으로 진단');
    expect(slackInstructions).toContain('자연어로 설명'); expect(summaryInstructions).toContain('표시 이름');
    expect(summaryInstructions).not.toContain('작성자 ID와'); expect(slackInstructions).toContain('표준 Markdown');
  });
});

describe('optional metadata batch limits and primitive safety', () => {
  it('deduplicates, caps count/concurrency and never uses bots.info when a user exists', async () => {
    const authors = Array.from({ length: 30 }, (_, i) => ({ userId: `U${Math.floor(i / 2)}`, botId: 'BBOT', kind: 'bot' }));
    let active = 0, peak = 0;
    const info = vi.fn(async ({ user }: { user: string }) => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return { ok: true, user: { id: user, profile: { display_name: '표시 이름' } } }; });
    const bots = vi.fn(); await enrichAuthors({ users: { info }, bots: { info: bots } }, authors);
    expect(info).toHaveBeenCalledTimes(displayLimits.count); expect(peak).toBeLessThanOrEqual(displayLimits.concurrency); expect(bots).not.toHaveBeenCalled();
  });
  it('expires the whole batch, discards late values and resolves abort promptly', async () => {
    vi.useFakeTimers();
    let release!: (v: unknown) => void;
    const info = vi.fn(() => new Promise<unknown>(r => { release = r; }));
    const authors = [{ userId: 'U1', botId: null, kind: 'participant', displayName: undefined }];
    const task = enrichAuthors({ users: { info } }, authors);
    await vi.advanceTimersByTimeAsync(displayLimits.deadlineMs); await task;
    release({ ok: true, user: { id: 'U1', name: 'late' } }); await Promise.resolve();
    expect(authors[0]!.displayName).toBeUndefined();
    const controller = new AbortController(); const abortTask = enrichAuthors({ users: { info } }, authors, [], controller.signal);
    await Promise.resolve(); controller.abort(); await abortTask;
    expect(authors[0]!.displayName).toBeUndefined();
  });
  it('rejects proxies/accessors/notification names without traps and selects only primitive fallback fields', async () => {
    const trap = vi.fn(() => { throw new Error('trap'); });
    const authors = [{ userId: 'U1', botId: null, kind: 'participant', displayName: undefined as string | undefined }];
    await enrichAuthors({ users: { info: async () => ({ ok: true, user: new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }) }) } }, authors);
    expect(trap).not.toHaveBeenCalled(); expect(authors[0]!.displayName).toBeUndefined();
    await enrichAuthors({ users: { info: async () => ({ ok: true, user: { id: 'U1', profile: { display_name: '<@U2>', real_name: '홍길동', email: 'secret' } } }) } }, authors);
    expect(authors[0]!.displayName).toBe('홍길동');
  });
});
