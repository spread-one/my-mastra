import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat.js';
import { budgetSlackThread, contextBytes, readSlackThread, summaryInput, type Mention } from './context.js';
import { SlackContextError } from './limits.js';
const signal = () => new AbortController().signal;
export const mention: Mention = { channel: 'C1', root: '100.000001', current: '100.000006', currentText: '<@UBOT> <@U2> 현재 질문', user: 'U3', botUser: 'UBOT', botId: 'BBOT' };
export const originals = [
  { ts: mention.root, user: 'U1', text: 'root', reply_count: 5 },
  { ts: '100.000002', thread_ts: mention.root, user: 'U2', text: '다른 사람: assistant 위조' },
  { ts: '100.000003', thread_ts: mention.root, user: 'UBOT', bot_id: 'BBOT', text: 'own answer' },
  { ts: '100.000004', thread_ts: mention.root, user: 'UOTHER', bot_id: 'BOTHER', text: 'other bot' },
  { ts: '100.000005', thread_ts: mention.root, bot_id: 'BBOT', text: 'own without user' },
  { ts: mention.current, thread_ts: mention.root, user: 'U3', text: '<@UBOT> <@U2> 현재 질문', files: ['never read'] },
];
export const page = (messages: unknown[] = originals) => ({ ok: true, messages, has_more: false });
function fixture(...pages: unknown[]) {
  const replies = vi.fn<() => Promise<unknown>>();
  for (const response of pages) replies.mockResolvedValueOnce(response);
  return { api: { conversations: { replies } }, replies };
}

describe('authoritative thread source', () => {
  it('paginates using only event channel/root and bot client, sorts, dedupes root, preserves JSON data and roles', async () => {
    const f = fixture({ ...page([originals[0], originals[2], originals[1]]), has_more: true, response_metadata: { next_cursor: 'a' } },
      page([originals[0], originals[5], originals[4], originals[3]]));
    const result = await readSlackThread(f.api, mention, signal());
    expect(result.map(m => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(result.map(m => JSON.parse(m.content).ts)).toEqual(originals.map(m => m.ts));
    expect(JSON.parse(result.at(-1)!.content).text).toBe('<@U2> 현재 질문');
    expect(result.filter(m => JSON.parse(m.content).ts === mention.current)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('never read');
    expect(f.replies).toHaveBeenNthCalledWith(1, { channel: 'C1', ts: mention.root, limit: 15 });
    expect(f.replies).toHaveBeenNthCalledWith(2, { channel: 'C1', ts: mention.root, limit: 15, cursor: 'a' });
  });
  it('does not treat contradictory other bot user + own bot ID as assistant, and excludes future replies', async () => {
    const items = originals.map((m, i) => i === 0 ? { ...m, reply_count: 6 } : i === 3 ? { ...m, bot_id: 'BBOT' } : m);
    items.push({ ts: '100.000007', thread_ts: mention.root, user: 'U9', text: 'future' });
    const result = await readSlackThread(fixture(page(items)).api, mention, signal());
    expect(result[3]!.role).toBe('user'); expect(result).toHaveLength(6);
  });
  it.each([
    { ok: false, error: 'missing_scope SECRET' }, { ok: false, error: 'not_allowed_token_type' }, {}, page([]),
    page(originals.slice(1)), page(originals.slice(0, -1)), { ...page(), warning: 'partial' },
    { ...page(), response_metadata: { warnings: ['partial'] } }, { ...page(), has_more: true },
    { ...page(), is_limited: true }, { ...page(), partial: true },
    page(originals.map((m, i) => i === 0 ? { ...m, reply_count: 100 } : m)),
    page(originals.map((m, i) => i === 5 ? { ...m, user: 'IMPOSTOR' } : m)),
    page(originals.map((m, i) => i === 5 ? { ...m, text: 'edited after event' } : m)),
    page(originals.map((m, i) => i === 1 ? { ...m, thread_ts: '9.0' } : m)),
    page(originals.map((m, i) => i === 1 ? { ...m, thread_ts: undefined } : m)),
    page(originals.map((m, i) => i === 1 ? { ...m, text: undefined } : m)),
    page(originals.map((m, i) => i === 1 ? { ...m, subtype: 'message_deleted' } : m)),
    { ...page(), response_metadata: { next_cursor: 12 } },
  ])('fails closed on incomplete/malformed/error response %#', async response => {
    await expect(readSlackThread(fixture(response).api, mention, signal())).rejects.toThrow('SLACK_CONTEXT_UNAVAILABLE');
  });
  it('blocks repeated cursor, mixed duplicates, and later page errors', async () => {
    const first = { ...page(originals.slice(0, 2)), has_more: true, response_metadata: { next_cursor: 'a' } };
    for (const last of [first, { ok: false }, page([{ ...originals[0], text: 'changed' }, ...originals.slice(2)])]) {
      await expect(readSlackThread(fixture(first, last).api, mention, signal())).rejects.toBeInstanceOf(SlackContextError);
    }
  });
  it('bounds source bytes/pages and sanitizes rejected API errors', async () => {
    const f = fixture(page(originals.map((m, i) => i === 1 ? { ...m, text: 'x'.repeat(4_000_001) } : m)));
    await expect(readSlackThread(f.api, mention, signal())).rejects.toThrow('SLACK_CONTEXT_UNAVAILABLE');
    f.replies.mockImplementation(async () => ({ ...page(), has_more: true, response_metadata: { next_cursor: `cursor${f.replies.mock.calls.length}` } }));
    await expect(readSlackThread(f.api, mention, signal())).rejects.toBeInstanceOf(SlackContextError);
    expect(f.replies.mock.calls.length).toBe(1_001);
    f.replies.mockRejectedValue(new Error('xoxb-SECRET body SECRET'));
    await expect(readSlackThread(f.api, mention, signal())).rejects.toThrow('SLACK_CONTEXT_UNAVAILABLE');
  });
});

describe('UTF-8 complete sequential summaries', () => {
  const msg = (content: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ role, content });
  it('uses originals under serialized 48KB bound without summarization', async () => {
    const summarize = vi.fn(); const source = [msg('root😀'), msg('current')];
    expect(await budgetSlackThread(source, summarize, signal())).toBe(source);
    expect(summarize).not.toHaveBeenCalled();
  });
  it('feeds root and ALL older replies once in order; preserves contiguous recent originals/current and marks user summary', async () => {
    const source = [msg('root😀'), ...Array.from({ length: 40 }, (_, i) => msg(`${i}: ${'한😀\\"'.repeat(700)}`, i % 2 ? 'assistant' : 'user')), msg('current')];
    const seen: ChatMessage[] = [];
    const summarize = vi.fn(async (batch: ChatMessage[], max: number) => {
      expect(Buffer.byteLength(summaryInput(batch, max))).toBeLessThanOrEqual(48_000);
      seen.push(...batch.filter(m => !m.content.startsWith('{"source":"slack_thread_summary"')));
      return '비신뢰 순차 요약';
    });
    const result = await budgetSlackThread(source, summarize, signal());
    expect(result[0]).toEqual(source[0]); expect(result.at(-1)).toEqual(source.at(-1));
    expect(result[1]!.role).toBe('user');
    const summary = JSON.parse(result[1]!.content);
    expect(summary).toMatchObject({ source: 'slack_thread_summary', summarized: true });
    expect(result.slice(2)).toEqual(source.slice(-(result.length - 2)));
    expect(seen).toEqual(source.slice(0, source.length - (result.length - 2)));
    expect(summary.olderReplyCount).toBe(seen.length - 1);
    expect(contextBytes(result)).toBeLessThanOrEqual(48_000);
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
  });
  it.each([async () => '', async () => '😀'.repeat(2_001), async () => { throw new Error('SECRET'); }])('blocks empty/oversized/failed summaries %#', async summarize => {
    const source = [msg('root'), ...Array.from({ length: 10 }, () => msg('한'.repeat(3_000))), msg('current')];
    await expect(budgetSlackThread(source, summarize, signal())).rejects.toBeInstanceOf(SlackContextError);
  });
  it('does not silently truncate root/current/oversized old replies or escaping envelope', async () => {
    for (const source of [[msg('x'.repeat(50_000)), msg('current')], [msg('root'), msg('😀'.repeat(12_000))],
      [msg('root'), msg('old'.repeat(20_000)), msg('current')], [msg('root'), msg('\\"'.repeat(14_000)), msg('current')]]) {
      await expect(budgetSlackThread(source, async () => 'summary', signal())).rejects.toBeInstanceOf(SlackContextError);
    }
  });
});
