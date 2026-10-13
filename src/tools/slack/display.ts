import { types } from 'node:util';
import { setTimeout, clearTimeout } from 'node:timers';
import { sanitizeSlackSource } from '../../slack/format.js';

/** Optional metadata: inspect own primitive data only; never invoke accessors or proxies. */
export function displayField(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && 'value' in d ? d.value : undefined;
  } catch { return undefined; }
}
export function displayName(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f-\u009f]|<[@#!]|@(everyone|here|channel)\b/u.test(value)) return undefined;
  const safe = sanitizeSlackSource(value.trim(), secrets);
  return safe && safe.length <= 80 ? safe : undefined;
}
export const displayLimits = Object.freeze({ count: 8, concurrency: 2, deadlineMs: 800 });
type Author = { userId: string | null; botId: string | null; kind: string; displayName?: string };
export type DisplayClient = {
  users?: { info: (args: { user: string }) => Promise<unknown> };
  bots?: { info: (args: { bot: string }) => Promise<unknown> };
};

/** Invocation-local deduplication, deadline and count. Display data never becomes identity or a grant. */
export async function enrichAuthors(client: DisplayClient, authors: Author[], secrets: readonly string[] = [], signal?: AbortSignal): Promise<void> {
  const unique = new Map<string, { id: string; user: boolean }>();
  const key = (a: Author) => a.userId ? `u:${a.userId}` : a.botId ? `b:${a.botId}` : '';
  for (const a of authors) {
    const id = a.userId ?? a.botId;
    if (id && (a.userId ? /^[UW][A-Z0-9]{1,63}$/u : /^B[A-Z0-9]{1,63}$/u).test(id) && !unique.has(key(a)) && unique.size < displayLimits.count)
      unique.set(key(a), { id, user: !!a.userId });
  }
  const names = new Map<string, string>();
  const jobs = [...unique.entries()];
  let index = 0;
  const deadline = Date.now() + displayLimits.deadlineMs;
  async function worker() {
    while (index < jobs.length && !signal?.aborted && Date.now() < deadline) {
      const [k, job] = jobs[index++]!;
      const invoke = job.user ? client.users && (() => client.users!.info({ user: job.id })) : client.bots && (() => client.bots!.info({ bot: job.id }));
      if (!invoke) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const raw = await Promise.race([
          Promise.resolve().then(invoke),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
            abort = () => resolve(undefined);
            signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
        if (signal?.aborted || Date.now() >= deadline || displayField(raw, 'ok') !== true) continue;
        const entity = displayField(raw, job.user ? 'user' : 'bot');
        if (displayField(entity, 'id') !== job.id) continue;
        const profile = job.user ? displayField(entity, 'profile') : undefined;
        const name = (job.user ? [displayField(profile, 'display_name'), displayField(profile, 'real_name'), displayField(entity, 'name')] : [displayField(entity, 'name')])
          .map(v => displayName(v, secrets)).find(Boolean);
        if (name) names.set(k, name);
      } catch { /* missing users:read, rate limit, malformed metadata: display fallback only */ }
      finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
    }
  }
  await Promise.all(Array.from({ length: displayLimits.concurrency }, worker));
  for (const a of authors) {
    const name = names.get(key(a));
    if (name) a.displayName = name;
    // Missing optional metadata is rendered by instructions as generic participant/bot, never an ID.
  }
}
