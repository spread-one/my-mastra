// Adapted with permission from user-owned Shookie PR90 continuation tests.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWebTools, findInput } from './tools.js';
import { ContentStore, CONTENT_LIMITS, contentScope, textWindow } from './content.js';
import { LIMITS, type Connector } from './network.js';

const identity = { teamId: 'T1', userId: 'U1', channel: 'C1', threadTs: '123.456' };
function context(changes: Record<string, unknown> = {}) { return new RequestContext<unknown>(Object.entries({ ...identity, ...changes })); }
function fixture(body: string | Buffer = 'hello', contentType = 'text/plain') {
  const connector = vi.fn<Connector>(async () => {
    const stream = new PassThrough() as unknown as http.IncomingMessage;
    stream.statusCode = 200; stream.headers = { 'content-type': contentType };
    queueMicrotask(() => (stream as unknown as PassThrough).end(body));
    return stream;
  });
  return { connector, resolver: async () => [{ address: '93.184.216.34', family: 4 }] };
}
async function run(tools: ReturnType<typeof createWebTools>, name: string, input: unknown, requestContext?: RequestContext) {
  return tools[name]!.execute!(input as never, { requestContext } as never) as Promise<any>;
}
const source = { originalUrl: 'https://source.org', finalUrl: 'https://source.org/', fetchedAt: '2026-01-01T00:00:00Z', contentType: 'text/plain', title: '' };
const scope = contentScope(context())!;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('source-bound continuation', () => {
  it('finds and reads a marker only after 30k, retaining one download and immutable source', async () => {
    const body = '앞'.repeat(31_000) + '\nMARKER 한글😀\n끝';
    const network = fixture(body);
    const tools = createWebTools({ network, contentStore: new ContentStore() });
    const fetched = await run(tools, 'web_fetch', { url: source.originalUrl, maxChars: 30_000 }, context());
    expect(fetched).toMatchObject({ ok: true, evidence: 'fetched_text', totalChars: body.length, nextOffset: 30_000, storage: 'available', offsetUnit: 'utf16_code_units' });
    expect(fetched.text).not.toContain('MARKER');
    expect(fetched.contentId).toMatch(/^[a-f0-9-]{36}$/);
    const more = await run(tools, 'web_read_more', { contentId: fetched.contentId, offset: fetched.nextOffset }, context({ requestId: 'different-request' }));
    const found = await run(tools, 'web_find_in_content', { contentId: fetched.contentId, literal: 'MARKER' }, context());
    expect(more.text).toBe(body.slice(30_000));
    expect(more).toMatchObject({ lines: { start: 1, end: 3 }, nextOffset: null, complete: true, truncated: false });
    expect(found).toMatchObject({ ok: true, evidence: 'fetched_text', resultKind: 'literal_matches', matches: [{ offset: 31_001, endOffset: 31_007, lines: { start: 2, end: 2 } }] });
    for (const result of [more, found]) {
      expect(result.fetchedAt).toBe(fetched.fetchedAt); expect(result.finalUrl).toBe(fetched.finalUrl);
      expect(result.originalUrl).toBe(fetched.originalUrl); expect(result.title).toBe(fetched.title);
    }
    expect(network.connector).toHaveBeenCalledTimes(1);
  });
  it('scopes every retrieval to actor/team/channel/thread, rejecting unknown or missing context identically', async () => {
    const tools = createWebTools({ network: fixture(), contentStore: new ContentStore() });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
    for (const name of ['web_read_more', 'web_find_in_content']) {
      const input = { contentId: f.contentId, offset: 0, literal: 'hello', teamId: 'T1', userId: 'U1' };
      for (const key of Object.keys(identity)) {
        expect(await run(tools, name, input, context({ [key]: 'other' }))).toMatchObject({ ok: false, error: { code: 'CONTENT_UNAVAILABLE' } });
      }
      expect(await run(tools, name, { ...input, contentId: randomUUID() }, context())).toMatchObject({ ok: false, error: { code: 'CONTENT_UNAVAILABLE' } });
      for (const ctx of [undefined, context({ teamId: undefined }), context({ userId: '' })]) {
        expect(await run(tools, name, input, ctx)).toMatchObject({ ok: false, error: { code: 'CONTENT_CONTEXT_REQUIRED' } });
      }
    }
  });
  it('legacy or incomplete context fetch returns text but never caches or exposes an ID', async () => {
    const store = new ContentStore(); const put = vi.spyOn(store, 'put');
    const tools = createWebTools({ network: fixture('body'), contentStore: store });
    for (const ctx of [undefined, context({ teamId: undefined }), context({ threadTs: null })]) {
      const result = await run(tools, 'web_fetch', { url: source.originalUrl }, ctx);
      expect(result).toMatchObject({ ok: true, text: 'body', storage: 'context_unavailable' });
      expect(result).not.toHaveProperty('contentId');
    }
    expect(put).not.toHaveBeenCalled();
  });
  it('uses the process-wide store across separately created root tool sets', async () => {
    const ctx = context({ userId: randomUUID() });
    const f = await run(createWebTools({ network: fixture('shared') }), 'web_fetch', { url: source.originalUrl }, ctx);
    expect(await run(createWebTools(), 'web_read_more', { contentId: f.contentId, offset: 0 }, ctx)).toMatchObject({ ok: true, text: 'shared' });
  });
  it.each(['text/plain', 'text/html', 'application/json'])('keeps a sanitized full %s snapshot', async (type) => {
    const body = type === 'text/html' ? '<p>正文</p><script>evil()</script>' : type === 'application/json' ? '{"message":"正文"}' : '正文\r\n第二行';
    const tools = createWebTools({ network: fixture(body, type), contentStore: new ContentStore() });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
    const more = await run(tools, 'web_read_more', { contentId: f.contentId, offset: 0 }, context());
    expect(more.text).toBe(f.text); expect(more.text).not.toContain('evil()'); expect(more.text).not.toContain('\r');
  });
  it('does not relax download limit or turn unsupported/failing downloads into snapshots', async () => {
    for (const network of [fixture(Buffer.alloc(LIMITS.bodyBytes + 1)), fixture('pdf', 'application/pdf')]) {
      const store = new ContentStore(); const put = vi.spyOn(store, 'put');
      const f = await run(createWebTools({ network, contentStore: store }), 'web_fetch', { url: source.originalUrl }, context());
      expect(f.ok).toBe(false); expect(f).not.toHaveProperty('contentId'); expect(put).not.toHaveBeenCalled();
    }
  });
});

describe('bounded store lifecycle', () => {
  it('releases idle entries at TTL and does not refetch expired snapshots', async () => {
    vi.useFakeTimers();
    const store = new ContentStore({ ...CONTENT_LIMITS, ttlMs: 100 });
    const network = fixture('snapshot');
    const tools = createWebTools({ network, contentStore: store });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    vi.advanceTimersByTime(100);
    expect(clear).toHaveBeenCalled(); // Timer callback removed idle entry before any retrieval.
    for (const name of ['web_read_more', 'web_find_in_content']) {
      expect(await run(tools, name, { contentId: f.contentId, offset: 0, literal: 'snapshot' }, context())).toMatchObject({ ok: false, error: { code: 'CONTENT_UNAVAILABLE' } });
    }
    expect(network.connector).toHaveBeenCalledTimes(1);
  });
  it('expires without extending TTL on access; unknown/expired/evicted all fail closed', () => {
    let now = 1000; const store = new ContentStore({ ...CONTENT_LIMITS, ttlMs: 10 }, () => now);
    const saved = store.put(scope, source, 'text')!;
    now = 1009; expect(store.get(saved.contentId, scope).text).toBe('text');
    now = 1010; expect(() => store.get(saved.contentId, scope)).toThrow('CONTENT_UNAVAILABLE');
    expect(() => store.get(randomUUID(), scope)).toThrow('CONTENT_UNAVAILABLE');
    expect(store.put(scope, source, 'new')).toBeDefined();
  });
  it('caps actor entries across threads and rejects a new snapshot without evicting existing actor entries', () => {
    const store = new ContentStore({ ...CONTENT_LIMITS, actorEntries: 1 });
    const one = store.put(scope, source, 'one')!;
    expect(store.put(contentScope(context({ threadTs: 'different' }))!, source, 'two')).toBeUndefined();
    expect(store.get(one.contentId, scope).text).toBe('one');
    expect(store.put(contentScope(context({ userId: 'U2' }))!, source, 'two')).toBeDefined();
  });
  it('bounds global entries and charged bytes with FIFO eviction; reads do not refresh FIFO', () => {
    for (const limits of [{ entries: 2, totalBytes: 100_000 }, { entries: 100, totalBytes: 3000 }]) {
      const store = new ContentStore({ ...CONTENT_LIMITS, ...limits });
      const one = store.put(scope, source, 'one')!;
      store.put(scope, source, 'two'); store.get(one.contentId, scope);
      store.put(scope, source, 'three');
      expect(() => store.get(one.contentId, scope)).toThrow('CONTENT_UNAVAILABLE');
    }
  });
  it('charges text and metadata, rejecting per-actor/global oversize without leaking a cache ID', async () => {
    const store = new ContentStore({ ...CONTENT_LIMITS, actorBytes: 1200 });
    expect(store.put(scope, source, 'x'.repeat(1000))).toBeUndefined();
    expect(new ContentStore({ ...CONTENT_LIMITS, totalBytes: 1200 }).put(scope, source, 'x'.repeat(1000))).toBeUndefined();
    const tools = createWebTools({ network: fixture('x'.repeat(1000)), contentStore: store });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
    expect(f).toMatchObject({ ok: true, storage: 'quota_exceeded' }); expect(f).not.toHaveProperty('contentId');
  });
});

describe('Unicode, citations and literal limits', () => {
  it('reassembles overlong four-byte UTF-8 text without surrogate loss or offset drift', async () => {
    const text = '😀'.repeat(40_000) + '\n끝';
    const tools = createWebTools({ network: fixture(text), contentStore: new ContentStore() });
    let result = await run(tools, 'web_fetch', { url: source.originalUrl, maxChars: 101 }, context());
    const id = result.contentId;
    let combined = result.text;
    expect(result.nextOffset).toBe(100);
    while (result.nextOffset !== null) {
      result = await run(tools, 'web_read_more', { contentId: id, offset: result.nextOffset, maxChars: 30_000 }, context());
      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(CONTENT_LIMITS.textBytes);
      expect(Array.from(result.text as string).some(char => char.length === 1 && /[\uD800-\uDFFF]/u.test(char))).toBe(false);
      combined += result.text;
    }
    expect(combined).toBe(text);
    expect(result.totalBytes).toBe(Buffer.byteLength(text));
  });
  it('never splits emoji at end and rejects an offset in a surrogate pair', () => {
    const text = '한'.repeat(99) + '😀\n끝';
    const a = textWindow(text, 0, 100);
    expect(a.text).toBe('한'.repeat(99)); expect(a.nextOffset).toBe(99);
    expect(textWindow(text, 99, 100)).toMatchObject({ text: '😀\n끝', lines: { start: 1, end: 2 }, complete: true });
    expect(() => textWindow(text, 100, 100)).toThrow('INVALID_OFFSET');
    expect(textWindow('a\nb', 0, 2).lines).toEqual({ start: 1, end: 1 });
    expect(textWindow('a\nb', 2, 100).lines).toEqual({ start: 2, end: 2 });
    expect(textWindow('', 0, 100).lines).toEqual({ start: 0, end: 0 });
    expect(textWindow('한😀끝', 0, 100, 7).text).toBe('한😀');
  });
  it('finds literal regex-like syntax, multiline and emoji with exact line citations', async () => {
    const text = '한😀\n.*[x]\n한😀';
    const tools = createWebTools({ network: fixture(text), contentStore: new ContentStore() });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
    const search = (literal: string, offset = 0, count = 10) => run(tools, 'web_find_in_content', { contentId: f.contentId, literal, offset, count }, context());
    expect((await search('.*[x]')).matches).toMatchObject([{ offset: 4, endOffset: 9, lines: { start: 2, end: 2 } }]);
    expect((await search('😀\n.*')).matches[0].lines).toEqual({ start: 1, end: 2 });
    const first = await search('한😀', 0, 1);
    expect(first).toMatchObject({ truncated: true, complete: false, nextOffset: 3 });
    expect((await search('한😀', first.nextOffset, 1)).matches).toMatchObject([{ offset: 10, endOffset: 13, lines: { start: 3, end: 3 } }]);
    expect(await search('absent')).toMatchObject({ ok: true, matches: [], truncated: false, complete: true });
    expect(await search('😀', 2)).toMatchObject({ ok: false, error: { code: 'INVALID_OFFSET' } });
    expect(await run(tools, 'web_read_more', { contentId: f.contentId, offset: text.length + 1 }, context())).toMatchObject({ ok: false, error: { code: 'INVALID_OFFSET' } });
  });
  it('distinguishes empty content/end-of-content from errors and uses case-sensitive non-overlapping matches', async () => {
    for (const text of ['', 'aaaaA']) {
      const tools = createWebTools({ network: fixture(text), contentStore: new ContentStore() });
      const f = await run(tools, 'web_fetch', { url: source.originalUrl }, context());
      expect(await run(tools, 'web_read_more', { contentId: f.contentId, offset: text.length }, context())).toMatchObject({ ok: true, text: '', complete: true, nextOffset: null, lines: { start: 0, end: 0 } });
      const found = await run(tools, 'web_find_in_content', { contentId: f.contentId, literal: 'aa' }, context());
      expect(found.matches.map((m: any) => m.offset)).toEqual(text ? [0, 2] : []);
      expect(found.complete).toBe(true);
    }
  });
  it('rejects empty/whitespace, unpaired Unicode, excessive queries/count/chars; does not trim literals', () => {
    for (const literal of ['', ' ', '\n', '\ud800', 'a'.repeat(401)]) expect(findInput.safeParse({ contentId: randomUUID(), literal }).success).toBe(false);
    expect(findInput.parse({ contentId: randomUUID(), literal: ' a ' }).literal).toBe(' a ');
    expect(findInput.safeParse({ contentId: randomUUID(), literal: 'a', count: 21 }).success).toBe(false);
  });
  it('bounds read/find characters, UTF-8 bytes, count and encoded response bytes', async () => {
    const text = '한'.repeat(300_000);
    const tools = createWebTools({ network: fixture(text), contentStore: new ContentStore() });
    const f = await run(tools, 'web_fetch', { url: source.originalUrl, maxChars: 30_000 }, context());
    const read = await run(tools, 'web_read_more', { contentId: f.contentId, offset: 30_000, maxChars: 30_000 }, context());
    const found = await run(tools, 'web_find_in_content', { contentId: f.contentId, literal: '한', count: 20 }, context());
    expect(read.text.length).toBe(30_000); expect(Buffer.byteLength(read.text)).toBe(90_000);
    expect(found.matches.length).toBe(20); expect(found.truncated).toBe(true);
    const snippets = found.matches.map((m: any) => m.snippet.text).join('');
    expect(snippets.length).toBeLessThanOrEqual(CONTENT_LIMITS.searchTextChars);
    expect(Buffer.byteLength(snippets)).toBeLessThanOrEqual(CONTENT_LIMITS.searchTextBytes);
    for (const result of [f, read, found]) expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CONTENT_LIMITS.outputBytes);
    // Mastra validates the input before executing our implementation.
    expect(await run(tools, 'web_read_more', { contentId: f.contentId, offset: 0, maxChars: 30_001 }, context())).toMatchObject({ error: true });
  });
});
