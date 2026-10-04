export const SLACK_LIMITS = {
  contextBytes: 48_000, inputBytes: 8_000, sourceBytes: 4_000_000, pages: 1_000,
  summaryBytes: 8_000, deadlineMs: 90_000, apiTimeoutMs: 10_000,
  admitted: 32, perThread: 4, concurrency: 2,
  dedupeCount: 512, dedupeTtlMs: 10 * 60_000,
  dmCount: 128, dmBytes: 1_000_000, dmThreadBytes: 48_000, dmTurns: 12, dmTtlMs: 30 * 60_000,
  outputBytes: 40_000, outputChars: 20_000, sectionChars: 2_800, blocks: 40,
} as const;
export const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

export class SlackContextError extends Error { constructor() { super('SLACK_CONTEXT_UNAVAILABLE'); } }
export class SlackBusyError extends Error { constructor() { super('SLACK_BUSY'); } }
export class SlackInputError extends Error { constructor() { super('SLACK_INPUT'); } }
export class SlackCancelledError extends Error { constructor() { super('SLACK_CANCELLED'); } }

/** Bound even injected non-cooperative dependencies; consume late rejection without logging it. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new SlackCancelledError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new SlackCancelledError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** No retries on ambiguous writes/errors. Only an explicit rate-limit rejection may be retried once. */
export async function slackCall<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await abortable(call(), signal); }
    catch (error) {
      const limit = error as { code?: string; retryAfter?: number } | null;
      if (signal.aborted || attempt >= 1 || limit?.code !== 'slack_webapi_rate_limited_error' ||
          !Number.isFinite(limit.retryAfter) || limit.retryAfter! < 0 || limit.retryAfter! > 2) throw new Error('SLACK_API_FAILED');
      await sleep(Math.max(100, limit.retryAfter! * 1_000), signal);
    }
  }
}
