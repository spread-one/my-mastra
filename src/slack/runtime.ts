import type { ChatMessage } from '../chat.js';
import { bytes, SLACK_LIMITS, SlackBusyError, SlackCancelledError } from './limits.js';

export type RuntimeLimits = { admitted: number; perThread: number; concurrency: number; deadlineMs: number; dedupeCount: number; dedupeTtlMs: number };
type Job = { id: string; key: string; controller: AbortController; timer: ReturnType<typeof setTimeout>;
  execute: (signal: AbortSignal) => Promise<void>; resolve: () => void; reject: (error: Error) => void; started: boolean };

/** Bounded admission, FIFO within each team/channel/thread, independent threads may run concurrently. */
export class SlackRuntime {
  private jobs = new Map<string, Job>();
  private completed = new Map<string, number>();
  private queue: Job[] = [];
  private threads = new Set<string>();
  private active = 0;
  private stopped = false;
  constructor(private limits: RuntimeLimits = SLACK_LIMITS, private now = () => Date.now()) {}

  run(id: string, key: string, execute: Job['execute']): Promise<void> {
    this.prune();
    if (this.jobs.has(id) || this.completed.has(id)) return Promise.resolve();
    if (this.stopped) return Promise.reject(new SlackCancelledError());
    if (this.jobs.size >= this.limits.admitted || [...this.jobs.values()].filter(job => job.key === key).length >= this.limits.perThread) {
      this.remember(id); // Duplicate overload events must not emit repeated notices.
      return Promise.reject(new SlackBusyError());
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const controller = new AbortController();
    const job: Job = { id, key, controller, execute, resolve, reject, started: false,
      timer: setTimeout(() => this.cancel(job), this.limits.deadlineMs) };
    this.jobs.set(id, job); this.queue.push(job); this.drain();
    return promise;
  }

  private cancel(job: Job): void {
    clearTimeout(job.timer);
    job.controller.abort(); job.reject(new SlackCancelledError());
    if (!job.started) {
      this.queue = this.queue.filter(item => item !== job);
      this.finish(job); this.drain();
    }
    // Active non-cooperative operations keep their admission/concurrency slot until settled.
    // A deadline never creates unlimited zombie calls or concurrent same-thread execution.
  }
  private drain(): void {
    if (this.stopped) return;
    while (this.active < this.limits.concurrency) {
      const index = this.queue.findIndex(job => !this.threads.has(job.key));
      if (index < 0) break;
      const job = this.queue.splice(index, 1)[0]!;
      job.started = true; this.active++; this.threads.add(job.key);
      void Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted(); return job.execute(job.controller.signal);
      }).then(job.resolve, error => job.reject(error instanceof Error ? error : new Error('SLACK_RUN_FAILED'))).finally(() => {
        this.active--; this.threads.delete(job.key); this.finish(job); this.drain();
      });
    }
  }
  private finish(job: Job): void { clearTimeout(job.timer); this.jobs.delete(job.id); this.remember(job.id); }
  private remember(id: string): void {
    this.completed.set(id, this.now());
    while (this.completed.size > this.limits.dedupeCount) this.completed.delete(this.completed.keys().next().value!);
  }
  private prune(): void {
    for (const [id, time] of this.completed) if (this.now() - time >= this.limits.dedupeTtlMs) this.completed.delete(id);
  }
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const job of [...this.jobs.values()]) this.cancel(job);
  }
  get size(): number { return this.jobs.size; }
}

export type DmLimits = { dmCount: number; dmBytes: number; dmThreadBytes: number; dmTurns: number; dmTtlMs: number };
/** Successful DM pairs only. Bounded TTL/LRU process memory, never storage or model-supplied keys. */
export class DmCache {
  private entries = new Map<string, { time: number; messages: ChatMessage[]; size: number }>();
  private total = 0;
  constructor(private limits: DmLimits = SLACK_LIMITS, private now = () => Date.now()) {}
  private prune(): void {
    for (const [key, value] of this.entries) if (this.now() - value.time >= this.limits.dmTtlMs) this.delete(key);
  }
  get(key: string): ChatMessage[] {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return [];
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.messages.map(message => ({ ...message }));
  }
  set(key: string, messages: ChatMessage[]): void {
    this.prune(); this.delete(key);
    const bounded = messages.slice(-this.limits.dmTurns * 2).map(message => ({ ...message }));
    while (bounded.length && bytes(JSON.stringify(bounded)) > this.limits.dmThreadBytes) bounded.splice(0, 2);
    const size = bytes(JSON.stringify(bounded));
    if (!bounded.length || size > this.limits.dmBytes) return;
    this.entries.set(key, { time: this.now(), messages: bounded, size }); this.total += size;
    while (this.entries.size > this.limits.dmCount || this.total > this.limits.dmBytes) this.delete(this.entries.keys().next().value!);
  }
  delete(key: string): void { const entry = this.entries.get(key); if (entry) { this.total -= entry.size; this.entries.delete(key); } }
  clear(): void { this.entries.clear(); this.total = 0; }
  get size(): number { this.prune(); return this.entries.size; }
}
