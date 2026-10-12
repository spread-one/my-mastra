import { createDeepSeek } from '@ai-sdk/deepseek';
import { RequestContext } from '@mastra/core/request-context';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackReadClient, bindSlackReadContext, getSlackReadIdentity, getSlackExecutionSignal } from '../tools/slack/index.js';
import { fakeNetwork } from '../tools/attachments/network.test-helper.js';
import { pngFixture, visionResponse } from '../tools/images/fixtures.test-helper.js';
import { createSlackAttachmentAuthorization, createSlackRuntimeTools } from './tools.js';
import { createSlackModels } from './model.js';
import { createSlackHandlers, HISTORY_ERROR_TEXT } from './handlers.js';
import { SlackRuntime } from './runtime.js';
import { SLACK_LIMITS } from './limits.js';
import { openSqliteHistory } from './history/index.js';
import type { ChatMessage } from '../chat.js';

const root = '1700000000.000001', actionToken = 'SYNTHETIC_EVENT_PRIVATE_TOKEN';
const config = { deepseekApiKey: 'synthetic-deepseek', model: 'deepseek-chat', botToken: 'xoxb-synthetic', appToken: 'xapp-synthetic',
  vision: { apiKey: 'synthetic-vision', baseURL: 'https://vision-provider.org/v1', model: 'test-vision' } };
const envelope = (event_id = 'event1', team_id = 'T1') => ({ event_id, team_id });
const event = (override = {}) => ({ channel: 'D1', channel_type: 'im', user: 'U1', ts: root, text: '', subtype: 'file_share',
  files: [{ id: 'FTXT', name: '문서.txt', mimetype: 'text/plain' }, { id: 'FPNG', name: '그림.png', mimetype: 'image/png' }], action_token: actionToken, ...override });
const context = { botUserId: 'UBOT', botId: 'BBOT' };
const dirs: string[] = [];
const path = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-integration-')); dirs.push(dir); return join(dir, 'history.sqlite'); };
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });

function readSdk(options: { membership?: boolean; files?: string[]; warning?: boolean; foreignTeam?: boolean; removedAfterInfo?: boolean; fileMetadata?: Record<string, unknown> } = {}) {
  const calls: string[] = []; let downloaded = false;
  const png = pngFixture(), text = Buffer.from('verified document text');
  const client = createSlackReadClient({ token: config.botToken }, { adapter: async request => {
    expect(request.signal).toBeDefined();
    const method = request.url!.split('/').at(-1)!; calls.push(method);
    const args = new URLSearchParams(String(request.data));
    const fileId = args.get('file');
    let data: unknown = method === 'auth.test' ? { ok: true, bot_id: 'BBOT', team_id: options.foreignTeam ? 'T2' : 'T1' }
      : method === 'conversations.info' ? { ok: true, channel: { id: 'D1', is_im: true, user: options.membership === false ? 'U2' : 'U1' } }
      : method === 'files.info' ? { ok: true, ...(options.warning ? { warning: 'partial-private' } : {}), file: {
        id: fileId, name: fileId === 'FTXT' ? 'document.txt' : 'image.png', mimetype: fileId === 'FTXT' ? 'text/plain' : 'image/png',
        size: fileId === 'FTXT' ? text.length : png.length, mode: 'hosted', is_external: false,
        url_private_download: `https://files.slack.com/files-pri/T1-${fileId}/download`, ...options.fileMetadata } }
      : { ok: true, messages: [{ ts: root, user: 'U1', text: '', subtype: 'file_share', files:
        (options.removedAfterInfo && downloaded ? [] : options.files ?? ['FTXT', 'FPNG']).map(id => ({ id })) }] };
    if (method === 'files.info') downloaded = true;
    return { config: request, request: {}, status: 200, statusText: 'OK', headers: {}, data };
  } });
  return { client, calls, png, text };
}
function visionTransport() {
  const bodies: string[] = [];
  const request = ((url: URL, options: https.RequestOptions, callback: (r: unknown) => void) => {
    expect(url.href).toBe('https://vision-provider.org/v1/chat/completions');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer synthetic-vision' });
    const req = new EventEmitter() as EventEmitter & { end(body: string): void };
    req.end = body => { bodies.push(body); const response = Readable.from([Buffer.from(visionResponse('파생 이미지 해석: 빨간 점'))]);
      Object.assign(response, { statusCode: 200, headers: { 'content-type': 'application/json' } }); queueMicrotask(() => callback(response)); };
    return req;
  }) as unknown as typeof https.request;
  return { bodies, request };
}
/** Real DeepSeek/Mastra SDK stream, scripted SSE only; no actual provider call. */
function streamModel(toolCalls: readonly (readonly [string, Record<string, unknown>])[] = [
  ['slack_read_attachment', { fileId: 'FTXT', messageTs: root }],
  ['slack_analyze_image', { fileId: 'FPNG', messageTs: root }], ['slack_read_channel', {}] ]) {
  const requests: any[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const first = requests.length === 1;
    const delta = first ? { role: 'assistant', content: null, tool_calls: toolCalls.map(([name, args], index) => ({ index,
      id: `tool${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { role: 'assistant', content: '## 확인 결과\n\n**문서**와 이미지의 파생 해석을 확인했습니다.' };
    const chunk = (d: unknown, reason: string | null) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 0, model: config.model,
      choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, first ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  return { requests, model: createDeepSeek({ apiKey: config.deepseekApiKey, fetch })(config.model) };
}

describe('production integration: authenticated handler -> real SDK/tools -> render/stream -> real SQLite reopen', () => {
  it('reads an attachment-only human DM with live mock SDK files, inline mock vision, canonical disk history and new session reopen', async () => {
    const sdk = readSdk(), vision = visionTransport(), scripted = streamModel();
    const downloads = fakeNetwork([{ body: sdk.text }, { body: sdk.png, headers: { 'content-type': 'image/png' } }]);
    const model = createSlackModels(config, { config, client: sdk.client, model: scripted.model,
      toolTransport: { downloadDependencies: downloads, visionDependencies: { ...downloads, request: vision.request } } });
    const db = path(), history = await openSqliteHistory(db);
    const writes: Array<[string, Record<string, unknown>]> = [];
    const apiCall = vi.fn(async (name: string, args: Record<string, unknown>) => { writes.push([name, args]); return { ok: true, ts: '1800000000.000001' }; });
    const handlers = createSlackHandlers({ history, ...model,
      client: { chat: { postMessage: async () => { throw new Error('unexpected duplicate'); } }, conversations: { replies: async () => ({}) }, apiCall },
      secrets: [config.botToken, config.deepseekApiKey, config.vision.apiKey] });
    await handlers.receive('message', event(), envelope(), context);
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[0].tools.map((t: any) => t.function.name).sort()).toEqual([
      'slack_analyze_image', 'slack_read_attachment', 'slack_read_channel', 'slack_read_thread', 'slack_search',
      'web_fetch', 'web_find_in_content', 'web_read_more', 'web_search' ]);
    const toolResults = scripted.requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    expect(toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, evidence: 'slack_attachment_text' }),
      expect.objectContaining({ ok: true, evidence: 'derived_image_interpretation' }),
      expect.objectContaining({ status: 'ok' }) ]));
    expect(JSON.stringify(toolResults)).toContain('verified document text');
    expect(sdk.calls.filter(c => c === 'files.info')).toHaveLength(2);
    expect(downloads.requests).toHaveLength(2);
    expect(vision.bodies).toHaveLength(1);
    expect(vision.bodies[0]).toContain(sdk.png.toString('base64'));
    for (const secret of [actionToken, config.botToken, config.vision.apiKey, 'files.slack.com/files-pri']) {
      expect(JSON.stringify(scripted.requests)).not.toContain(secret);
      expect(JSON.stringify(writes)).not.toContain(secret);
      expect(vision.bodies[0]).not.toContain(secret);
    }
    expect(writes.filter(([method]) => method === 'chat.stopStream')).toHaveLength(1);
    const final = writes.at(-1)![1]; expect(final.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'header' })]));
    await handlers.shutdown();
    const reopened = await openSqliteHistory(db), received: ChatMessage[][] = [];
    const next = createSlackHandlers({ history: reopened, chat: async messages => { received.push(messages); return 'next'; }, summarize: async () => 'summary',
      client: { chat: { postMessage: async () => ({ ok: true }) }, conversations: { replies: async () => ({}) } } });
    await next.receive('message', event({ text: '이어 질문', subtype: undefined, files: undefined, ts: '1700000000.000002', thread_ts: root }), envelope('event2'), context);
    expect(received[0]).toHaveLength(3);
    expect(received[0]![1]!.content).toContain('**문서**'); // canonical Markdown, not rendered Slack mrkdwn.
    expect(JSON.parse(received[0]![0]!.content).attachments).toHaveLength(2);
    expect(JSON.stringify(await reopened.get(JSON.stringify(['T1', 'D1', root]), new AbortController().signal))).not.toContain(actionToken);
    expect(await reopened.get(JSON.stringify(['T2', 'D1', root]), new AbortController().signal)).toEqual([]);
    await next.shutdown();
  });

  it('automatic existing-thread reads use the silent SDK, live requester checks and the same context passed to agent.stream', async () => {
    const child = '1700000000.000002', text = Buffer.from('thread attachment evidence'), calls: string[] = [];
    const originalText = '<@UBOT> read this attachment';
    const candidate = { id: 'FTXT', name: 'document.txt', mimetype: 'text/plain' };
    const readClient = createSlackReadClient({ token: config.botToken }, { adapter: async request => {
      const method = request.url!.split('/').at(-1)!; calls.push(method); expect(request.signal).toBeDefined();
      const args = new URLSearchParams(String(request.data));
      const current = { ts: child, thread_ts: root, user: 'U1', text: originalText, files: [candidate] };
      const data = method === 'auth.test' ? { ok: true, team_id: 'T1', bot_id: 'BBOT' }
        : method === 'conversations.info' ? { ok: true, channel: { id: 'C1', context_team_id: 'T1', is_channel: true, is_group: false, is_private: false } }
        : method === 'conversations.members' ? { ok: true, members: ['U1'] }
        : method === 'files.info' ? { ok: true, file: { ...candidate, size: text.length, mode: 'hosted', url_private_download: 'https://files.slack.com/files-pri/T1-FTXT/download' } }
        : { ok: true, messages: args.has('oldest') ? [current] : [{ ts: root, user: 'U2', text: 'original root', reply_count: 1 }, current] };
      return { config: request, request: {}, status: 200, statusText: 'OK', headers: {}, data };
    } });
    const scripted = streamModel([['slack_read_attachment', { fileId: 'FTXT', messageTs: child, threadTs: root }]]);
    const models = createSlackModels(config, { config, client: readClient, model: scripted.model,
      toolTransport: { downloadDependencies: fakeNetwork([{ body: text }]) } });
    const handlers = createSlackHandlers({ readClient, summarize: models.summarize,
      chat: (messages, signal, progress, metadata) => {
        expect(getSlackReadIdentity(metadata!.requestContext)).toMatchObject({ teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: root });
        expect(getSlackExecutionSignal(metadata!.requestContext)).toBe(signal);
        expect([...metadata!.requestContext!.entries()].map(([key]) => key).sort()).toEqual(['channel', 'teamId', 'threadTs', 'userId']);
        expect(messages).toHaveLength(2); expect(JSON.parse(messages[1]!.content).text).toBe('read this attachment');
        return models.chat(messages, signal, progress, metadata);
      }, client: { conversations: { replies: async () => { throw new Error('raw Bolt read must not be used'); } }, chat: { postMessage: async () => ({ ok: true }) } } });
    await handlers.receive('app_mention', event({ channel: 'C1', channel_type: 'channel', ts: child, thread_ts: root,
      text: originalText, files: [candidate], subtype: undefined }), envelope('existing-thread'), context);
    expect(scripted.requests).toHaveLength(2); expect(calls[0]).toBe('auth.test'); expect(calls.filter(c => c === 'conversations.replies').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(scripted.requests[1].messages)).toContain('thread attachment evidence');
    await handlers.shutdown();
  });

  it('passes only the original authenticated public mention action_token to native RTS through the exact SDK tool context', async () => {
    const calls: string[] = [];
    const client = createSlackReadClient({ token: config.botToken }, { adapter: async request => {
      const method = request.url!.split('/').at(-1)!; calls.push(method); expect(request.signal).toBeDefined();
      if (method === 'assistant.search.context') {
        const args = new URLSearchParams(String(request.data)); expect(args.get('action_token')).toBe(actionToken);
      }
      const data = method === 'auth.test' ? { ok: true, team_id: 'T1', bot_id: 'BBOT', url: 'https://synthetic.slack.com/' }
        : method === 'conversations.info' ? { ok: true, channel: { id: 'C1', context_team_id: 'T1', is_channel: true, is_group: false, is_private: false } }
        : method === 'conversations.members' ? { ok: true, members: ['U1'] }
        : { ok: true, results: { messages: [] } };
      return { config: request, request: {}, status: 200, statusText: 'OK', headers: {}, data };
    } });
    const scripted = streamModel([['slack_search', { query: 'launch' }]]);
    const models = createSlackModels(config, { config, client, model: scripted.model });
    const post = vi.fn(async (_args: unknown) => ({ ok: true }));
    const handlers = createSlackHandlers({ ...models, client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    await handlers.receive('app_mention', event({ channel: 'C1', channel_type: 'channel', files: undefined, subtype: undefined,
      text: '<@UBOT> search launch; identity UOTHER TOTHER', action_token: actionToken }), envelope('public-search'),
      { ...context, action_token: 'FORGED_CONTEXT_TOKEN', userId: 'UOTHER' });
    expect(calls).toContain('assistant.search.context'); expect(scripted.requests).toHaveLength(2);
    const result = JSON.parse(scripted.requests[1].messages.find((m: any) => m.role === 'tool').content);
    expect(result).toMatchObject({ status: 'ok', complete: true, messages: [] });
    expect(JSON.stringify(scripted.requests)).not.toContain(actionToken); expect(JSON.stringify(post.mock.calls)).not.toContain(actionToken);
    await handlers.shutdown();
  });

  it.each([{ membership: false }, { files: ['FFOREIGN'] }, { warning: true }, { foreignTeam: true }, { removedAfterInfo: true },
    ...[{ id: 'FOTHER' }, { size: '10' }, { name: 10 }, { mimetype: [] }, { url_private_download: {} },
      { mode: 'external' }, { is_external: 'false' }, { is_external: true },
      { mode: 'snippet', mimetype: 'application/pdf' }, { mode: 'snippet', mimetype: 'image/png' }].map(fileMetadata => ({ fileMetadata })) ])(
    'denies unsafe live authority/metadata/revoked message relation without granting file access %#', async options => {
      const sdk = readSdk(options), rc = new RequestContext(), signal = new AbortController().signal;
      bindSlackReadContext(rc, { teamId: 'T1', userId: 'U1', channel: 'D1', requestId: 'request', threadTs: root }, actionToken, signal);
      await expect(createSlackAttachmentAuthorization(sdk.client)('FTXT', root, rc, undefined, signal)).rejects.toMatchObject({
        code: 'fileMetadata' in options && options.fileMetadata?.mimetype === 'image/png' ? 'UNSUPPORTED_TYPE' : 'ACCESS_DENIED' });
    });
  it('public context fields and file candidate IDs cannot manufacture Slack authority; missing vision is truthful', async () => {
    const sdk = readSdk(), rc = new RequestContext(Object.entries({ teamId: 'T1', userId: 'U1', channel: 'D1', threadTs: root }));
    await expect(createSlackAttachmentAuthorization(sdk.client)('FTXT', root, rc)).rejects.toThrow('ACCESS_DENIED');
    expect(sdk.calls).toEqual([]);
    const tools = createSlackRuntimeTools({ ...config, vision: undefined }, sdk.client);
    const result = await tools.slack_analyze_image!.execute!({ fileId: 'FPNG', messageTs: root }, { requestContext: rc } as any);
    expect(result).toMatchObject({ ok: false, error: { code: 'VISION_CONFIG' } }); expect(sdk.calls).toEqual([]);
  });

  it('blocks action-token/configured-secret reflection from authorized document bytes before tool messages', async () => {
    const body = Buffer.from(actionToken + ' ' + config.vision.apiKey), sdk = readSdk({ fileMetadata: { size: body.length } });
    const rc = new RequestContext(), signal = new AbortController().signal;
    bindSlackReadContext(rc, { teamId: 'T1', userId: 'U1', channel: 'D1', requestId: 'request', threadTs: root }, actionToken, signal);
    const tools = createSlackRuntimeTools(config, sdk.client, { downloadDependencies: fakeNetwork([{ body }]) });
    const result = await tools.slack_read_attachment!.execute!({ fileId: 'FTXT', messageTs: root }, { requestContext: rc, abortSignal: signal } as any);
    expect(result).toMatchObject({ ok: false, error: { code: 'PRIVATE_OUTPUT_BLOCKED' } });
    expect(JSON.stringify(result)).not.toContain(actionToken); expect(JSON.stringify(result)).not.toContain(config.vision.apiKey);
  });

  it('a failed/aborted late final delivery cannot persist a turn, and shutdown retains other keys', async () => {
    const db = path(), history = await openSqliteHistory(db), signal = new AbortController().signal;
    const other = JSON.stringify(['T1', 'D2', root]);
    await history.set(other, [{ role: 'user', content: '{"author":{"userId":"U2"},"text":"prior"}' }, { role: 'assistant', content: 'prior answer' }], signal);
    let resolve!: (value: unknown) => void;
    let started!: () => void;
    const posted = new Promise<void>(yes => { started = yes; });
    const handlers = createSlackHandlers({ history, chat: async () => 'late', summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: () => { started(); return new Promise(yes => { resolve = yes; }); } } } });
    const run = handlers.receive('message', event({ text: 'hello', subtype: undefined, files: undefined }), envelope('late'), context);
    await posted;
    const closing = handlers.shutdown(); resolve({ ok: true });
    await run; await closing;
    await expect(history.get(other, signal)).rejects.toThrow('CLOSED');
    const reopened = await openSqliteHistory(db);
    expect(await reopened.get(JSON.stringify(['T1', 'D1', root]), signal)).toEqual([]);
    expect((await reopened.get(other, signal))[1]!.content).toBe('prior answer');
    await reopened.close();
  });

  it('admission deadline fences a non-cooperative late model and preserves previously committed real disk pairs', async () => {
    vi.useFakeTimers();
    const db = path(), history = await openSqliteHistory(db), signal = new AbortController().signal, key = JSON.stringify(['T1', 'D1', root]);
    const prior: ChatMessage[] = [{ role: 'user', content: '{"source":"slack_event","author":{"userId":"U1"},"text":"prior"}' }, { role: 'assistant', content: 'prior answer' }];
    await history.set(key, prior, signal);
    let finish!: (answer: string) => void;
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, deadlineMs: 20 });
    const post = vi.fn(async (_args: unknown) => ({ ok: true }));
    const chat = vi.fn(() => new Promise<string>(yes => { finish = yes; }));
    const handlers = createSlackHandlers({ history, runtime, chat, summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    const run = handlers.receive('message', event({ text: 'new', subtype: undefined, files: undefined, thread_ts: root, ts: '1700000000.000002' }), envelope('deadline-real'), context);
    await vi.advanceTimersByTimeAsync(1); expect(chat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20); await run; expect(runtime.size).toBe(1);
    finish('late answer must never commit'); await runtime.settled();
    expect(await history.get(key, signal)).toEqual(prior); expect(JSON.stringify(post.mock.calls)).not.toContain('late answer');
    await handlers.shutdown();
    const reopened = await openSqliteHistory(db); expect(await reopened.get(key, signal)).toEqual(prior); await reopened.close();
  });

  it('real disk reopened handler isolates teams/DM channels/roots and refuses a contradictory actor without destroying prior data', async () => {
    const db = path(), original = await openSqliteHistory(db), signal = new AbortController().signal, key = JSON.stringify(['T1', 'D1', root]);
    await original.set(key, [{ role: 'user', content: '{"source":"slack_event","author":{"userId":"U1"},"text":"private prior"}' }, { role: 'assistant', content: 'private answer' }], signal);
    await original.close(); const history = await openSqliteHistory(db);
    const seen: ChatMessage[][] = [], post = vi.fn(async (_args: unknown) => ({ ok: true }));
    const handlers = createSlackHandlers({ history, chat: async messages => { seen.push(messages); return 'fresh'; }, summarize: async () => '',
      client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    const human = { text: 'new', subtype: undefined, files: undefined, thread_ts: root, ts: '1700000000.000002' };
    await handlers.receive('message', event({ ...human, user: 'U2' }), envelope('foreign-actor'), context);
    expect(seen).toEqual([]); expect(post.mock.calls[0]![0]).toMatchObject({ text: HISTORY_ERROR_TEXT });
    expect((await history.get(key, signal))[1]!.content).toBe('private answer');
    await handlers.receive('message', event(human), envelope('foreign-team', 'T2'), context);
    await handlers.receive('message', event({ ...human, user: 'U2', channel: 'D2' }), envelope('foreign-dm'), context);
    await handlers.receive('message', event({ ...human, thread_ts: '1700000000.000000' }), envelope('foreign-root'), context);
    expect(seen).toHaveLength(3); for (const messages of seen) { expect(messages).toHaveLength(1); expect(JSON.stringify(messages)).not.toContain('private prior'); }
    await handlers.shutdown();
  });

  it('corrupt/unavailable history refuses a DM before model execution with a static notice', async () => {
    const history = await openSqliteHistory(path()); await history.close();
    const chat = vi.fn(async () => 'unsafe missing-context answer'), post = vi.fn(async (_args: unknown) => ({ ok: true }));
    const handlers = createSlackHandlers({ history, chat, summarize: async () => '', client: { conversations: { replies: async () => ({}) }, chat: { postMessage: post } } });
    await handlers.receive('message', event({ text: 'hello', subtype: undefined, files: undefined }), envelope('closed'), context);
    expect(chat).not.toHaveBeenCalled(); expect(post.mock.calls[0]![0]).toMatchObject({ text: HISTORY_ERROR_TEXT });
    await handlers.shutdown();
  });
});
