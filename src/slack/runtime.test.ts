import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmCache, SlackRuntime } from './runtime.js';
import { SlackBusyError, SlackCancelledError, SLACK_LIMITS } from './limits.js';
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('bounded in-process scheduling', () => {
  it('suppresses running, successful and failed duplicates; expiry and count are bounded', async () => {
    let now = 0;
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, dedupeCount: 2, dedupeTtlMs: 10 }, () => now);
    const hold = gate(); const work = vi.fn(async () => hold.promise);
    const run = runtime.run('a', 'thread', work);
    await runtime.run('a', 'thread', work); await tick(); expect(work).toHaveBeenCalledTimes(1);
    hold.resolve(); await run; await tick(); await runtime.run('a', 'thread', work);
    expect(work).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => { throw new Error('failed'); });
    await expect(runtime.run('b', 'thread', bad)).rejects.toThrow('failed'); await tick();
    await runtime.run('b', 'thread', bad); expect(bad).toHaveBeenCalledTimes(1);
    await runtime.run('c', 'other', work); await tick(); // evict oldest complete a
    await runtime.run('a', 'thread', work); expect(work).toHaveBeenCalledTimes(3);
    await tick(); now = 10; await runtime.run('b', 'thread', bad).catch(() => {});
    expect(bad).toHaveBeenCalledTimes(2); runtime.shutdown();
  });
  it('serializes threads, runs independent threads, bounds queue and global concurrency, releases all maps', async () => {
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, admitted: 4, perThread: 2, concurrency: 2 });
    const hold = gate(); const started: string[] = [];
    const work = (name: string) => async () => { started.push(name); await hold.promise; };
    const runs = [runtime.run('a', 'same', work('a')), runtime.run('b', 'same', work('b'))];
    await expect(runtime.run('overflow', 'same', work('overflow'))).rejects.toBeInstanceOf(SlackBusyError);
    await runtime.run('overflow', 'same', work('duplicate')); // overload also deduped
    runs.push(runtime.run('c', 'other', work('c')), runtime.run('d', 'another', work('d')));
    await expect(runtime.run('global', 'next', work('global'))).rejects.toBeInstanceOf(SlackBusyError);
    await tick(); expect(started).toEqual(['a', 'c']); expect(runtime.size).toBe(4);
    hold.resolve(); await Promise.all(runs); await tick();
    expect(started).toEqual(['a', 'c', 'b', 'd']); expect(runtime.size).toBe(0); runtime.shutdown();
  });
  it('deadline includes queue; active non-cooperative work retains its slot, cannot deliver later or multiply zombies', async () => {
    vi.useFakeTimers(); const hold = gate(); const started = vi.fn(); let activeSignal!: AbortSignal;
    const runtime = new SlackRuntime({ ...SLACK_LIMITS, deadlineMs: 10, concurrency: 1 });
    const a = runtime.run('a', 'same', async signal => { activeSignal = signal; await hold.promise; });
    const b = runtime.run('b', 'same', async () => { started(); });
    const aCheck = expect(a).rejects.toBeInstanceOf(SlackCancelledError);
    const bCheck = expect(b).rejects.toBeInstanceOf(SlackCancelledError);
    await vi.advanceTimersByTimeAsync(10); await Promise.all([aCheck, bCheck]);
    expect(activeSignal.aborted).toBe(true); expect(started).not.toHaveBeenCalled(); expect(runtime.size).toBe(1);
    await runtime.run('a', 'same', async () => { started(); }); expect(started).not.toHaveBeenCalled();
    hold.resolve(); await tick(); expect(runtime.size).toBe(0); runtime.shutdown();
  });
  it('shutdown aborts queued/active work, rejects new admission and does not start cancelled queued tasks', async () => {
    const runtime = new SlackRuntime(); const hold = gate(); const work = vi.fn(async () => hold.promise);
    const a = runtime.run('a', 'same', work), b = runtime.run('b', 'same', work);
    const checks = [expect(a).rejects.toBeInstanceOf(SlackCancelledError), expect(b).rejects.toBeInstanceOf(SlackCancelledError)];
    await tick(); runtime.shutdown(); await Promise.all(checks);
    await expect(runtime.run('c', 'other', work)).rejects.toBeInstanceOf(SlackCancelledError);
    expect(work).toHaveBeenCalledTimes(1); hold.resolve(); await tick(); expect(runtime.size).toBe(0);
  });
});

describe('bounded ephemeral DM cache', () => {
  const pair = (text: string) => [{ role: 'user' as const, content: text }, { role: 'assistant' as const, content: 'answer' }];
  it('isolates copies, bounds TTL/LRU/count/bytes and recent complete pairs', () => {
    let now = 0; const cache = new DmCache({ dmCount: 2, dmBytes: 500, dmThreadBytes: 200, dmTurns: 2, dmTtlMs: 10 }, () => now);
    cache.set('a', pair('😀')); cache.set('b', pair('b')); cache.get('a')[0]!.content = 'spoof';
    cache.set('c', pair('c')); expect(cache.get('b')).toEqual([]); expect(cache.get('a')[0]!.content).toBe('😀');
    cache.set('a', [...pair('old'.repeat(50)), ...pair('recent')]); expect(cache.get('a')).toEqual(pair('recent'));
    cache.set('huge', pair('x'.repeat(500))); expect(cache.size).toBe(2); expect(cache.get('huge')).toEqual([]);
    now = 10; expect(cache.size).toBe(0);
    expect(new DmCache().get('a')).toEqual([]);
  });
  it('enforces total bytes independently of count and never stores an oversized incomplete pair', () => {
    const cache = new DmCache({ ...SLACK_LIMITS, dmCount: 10, dmBytes: 120 });
    cache.set('a', pair('a')); cache.set('b', pair('b'));
    expect(cache.size).toBe(1); expect(cache.get('a')).toEqual([]);
    cache.clear(); expect(cache.size).toBe(0);
  });
});
