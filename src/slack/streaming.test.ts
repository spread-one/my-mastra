import { afterEach, expect, it, vi } from 'vitest';
import { SlackPlan } from './streaming.js';
import { formatSlack } from './format.js';
const target = { channel: 'C1', thread_ts: '100.1', recipient_team_id: 'T1', recipient_user_id: 'U1' };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const controller = new AbortController();
  const api = vi.fn(async (_method: string, _args: Record<string, unknown>): Promise<unknown> => ({ ok: true, ts: '200.1' }));
  const plan = new SlackPlan(api, target, controller.signal);
  return { controller, api, plan };
}
it('uses trusted recipients, opaque stable task IDs, static labels, and final blocks only once', async () => {
  const { plan, api } = fixture(); await plan.open();
  expect(api.mock.calls[0]).toEqual(['chat.startStream', { ...target, task_display_mode: 'plan' }]);
  await plan.progress({ toolCallId: 'SECRET_URL', toolName: 'web_search', state: 'in_progress' });
  await plan.progress({ toolCallId: 'SECRET_URL', toolName: 'web_search', state: 'complete' });
  await plan.progress({ toolCallId: 'SECRET_URL', toolName: 'web_search', state: 'complete' });
  await plan.progress({ toolCallId: 'missing', toolName: 'web_search', state: 'complete' });
  await plan.progress({ toolCallId: '', toolName: 'web_search', state: 'in_progress' });
  await plan.progress({ toolCallId: 'unknown', toolName: 'SECRET_QUERY', state: 'in_progress' });
  await plan.progress({ toolCallId: 'unknown', toolName: '__proto__', state: 'in_progress' });
  expect(api).toHaveBeenCalledTimes(3);
  expect(api.mock.calls[1]![1]).toMatchObject({ chunks: [{ id: 'task-1', title: '웹 검색', status: 'in_progress' }] });
  expect(api.mock.calls[2]![1]).toMatchObject({ chunks: [{ id: 'task-1', status: 'complete' }] });
  expect(JSON.stringify(api.mock.calls)).not.toMatch(/SECRET|details|output/u);
  const final = formatSlack('## 완료\n\n**답변** <@U1>');
  expect(await plan.deliver(final)).toBe(true); await plan.cleanup(); plan.dispose();
  expect(api.mock.calls.at(-1)).toEqual(['chat.stopStream', { channel: 'C1', ts: '200.1', ...final }]);
  expect(api).toHaveBeenCalledTimes(4);
});
it('bounds tasks and updates and ignores unstable/unknown result IDs', async () => {
  const { plan, api } = fixture(); await plan.open();
  for (let i = 0; i < 100; i++) {
    await plan.progress({ toolCallId: String(i), toolName: 'web_read_more', state: 'in_progress' });
    await plan.progress({ toolCallId: String(i), toolName: 'web_read_more', state: 'error' });
  }
  expect(api).toHaveBeenCalledTimes(49); await plan.cleanup();
});
it('uses ordinary delivery only when absent or explicitly unsupported, not ambiguous creation', async () => {
  const absent = new SlackPlan(undefined, target, new AbortController().signal);
  await absent.open(); expect(await absent.deliver(formatSlack('answer'))).toBe(false); absent.dispose();
  for (const failure of [{ ok: false, error: 'unknown_method' }, { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } }]) {
    const { api, plan } = fixture();
    if ('code' in failure) api.mockRejectedValueOnce(failure); else api.mockResolvedValueOnce(failure);
    await plan.open(); expect(plan.suppressNotice).toBe(false); expect(await plan.deliver(formatSlack('answer'))).toBe(false); plan.dispose();
  }
  const { api, plan } = fixture(); api.mockRejectedValueOnce(new Error('ambiguous SECRET'));
  await expect(plan.open()).rejects.toThrow('SLACK_STREAM_OPEN_FAILED'); expect(plan.suppressNotice).toBe(true);
  expect(api).toHaveBeenCalledOnce(); plan.dispose();
});
it.each([false, true])('append failure is ancillary; no retry or model recovery (%s)', async rejected => {
  const { plan, api } = fixture(); await plan.open();
  if (rejected) api.mockRejectedValueOnce(new Error('SECRET')); else api.mockResolvedValueOnce({ ok: false, error: 'invalid_chunks' });
  await plan.progress({ toolCallId: 'one', toolName: 'web_fetch', state: 'in_progress' });
  await plan.progress({ toolCallId: 'one', toolName: 'web_fetch', state: 'complete' });
  expect(await plan.deliver(formatSlack('answer'))).toBe(true); expect(api).toHaveBeenCalledTimes(3);
});
it.each([false, true])('never repeats an ambiguous or rejected stop write (%s)', async rejected => {
  const { plan, api } = fixture(); await plan.open();
  if (rejected) api.mockRejectedValueOnce(new Error('SECRET')); else api.mockResolvedValueOnce({ ok: false, error: 'internal_error' });
  await expect(plan.deliver(formatSlack('answer'))).rejects.toThrow(); await plan.cleanup();
  expect(api).toHaveBeenCalledTimes(2); expect(plan.suppressNotice).toBe(true);
});
it('append timeout is bounded and ancillary; final delivery is still single', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
  const { plan, api } = fixture(); await plan.open();
  api.mockImplementationOnce(() => new Promise(() => {}));
  const update = plan.progress({ toolCallId: 'one', toolName: 'web_find', state: 'in_progress' });
  await vi.advanceTimersByTimeAsync(10_000); await update;
  expect(await plan.deliver(formatSlack('answer'))).toBe(true); await plan.cleanup(); expect(api).toHaveBeenCalledTimes(3);
});
it('cleans up late creation after abort without any final text, only once', async () => {
  const { plan, api, controller } = fixture(); let resolve!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  const opened = expect(plan.open()).rejects.toThrow(); await tick(); controller.abort(); await opened;
  await plan.cleanup(); resolve({ ok: true, ts: '200.2' }); await tick(); await plan.cleanup();
  expect(api.mock.calls).toEqual([
    ['chat.startStream', { ...target, task_display_mode: 'plan' }],
    ['chat.stopStream', { channel: 'C1', ts: '200.2' }],
  ]); plan.dispose();
});
it('bounds noncooperative opening/cleanup; cleans late creation after UI timeout', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
  const { plan, api } = fixture(); let resolve!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  const opened = expect(plan.open()).rejects.toThrow(); await vi.advanceTimersByTimeAsync(10_000); await opened;
  api.mockImplementationOnce(() => new Promise(() => {})); resolve({ ok: true, ts: '200.3' }); await tick();
  await vi.advanceTimersByTimeAsync(5_000); await plan.cleanup(); expect(api).toHaveBeenCalledTimes(2); plan.dispose();
});
