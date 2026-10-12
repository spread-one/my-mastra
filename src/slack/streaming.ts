import type { ChatProgress } from '../chat.js';
import type { formatSlack } from './format.js';
import { abortable, SLACK_LIMITS } from './limits.js';

export type StreamApi = (method: string, args: Record<string, unknown>) => Promise<unknown>;
const labels: Readonly<Record<string, string>> = Object.freeze({
  web_search: '웹 검색', web_fetch: '웹 페이지 읽기', web_read_more: '웹 추가 읽기', web_find: '웹 내용 찾기',
  slack_search: 'Slack 검색', slack_read_thread: 'Slack 스레드 읽기', slack_read_history: 'Slack 기록 읽기',
  slack_read_attachment: '첨부 파일 읽기', slack_read_file: '파일 읽기', slack_analyze_image: '이미지 분석',
});
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const accepted = (value: unknown) => { const r = record(value); return r.ok === true && !r.error && !r.warning && !(record(r.response_metadata).warnings as unknown[] | undefined)?.length; };
const unsupported = new Set(['unknown_method', 'method_not_supported', 'not_allowed_token_type', 'missing_scope', 'feature_not_enabled']);

/** Request-local, bounded, best-effort plan. Never transmit model-supplied IDs or data. */
export class SlackPlan {
  private ts?: string;
  private disabled = false;
  private closed = false;
  private abandoned = false;
  private tasks = new Map<string, { id: string; title: string; finished: boolean }>();
  private events = 0;
  // True until an explicit rejection proves no stream was created. Suppresses duplicate writes.
  suppressNotice = false;
  constructor(private api: StreamApi | undefined, private target: { channel: string; thread_ts: string; recipient_team_id: string; recipient_user_id: string }, private signal: AbortSignal) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }
  private onAbort = () => { this.abandoned = true; void this.cleanup(); };
  private call(method: string, args: Record<string, unknown>, signal: AbortSignal) {
    return abortable(this.api!(method, args), AbortSignal.any([signal, AbortSignal.timeout(SLACK_LIMITS.apiTimeoutMs)]));
  }
  async open(): Promise<void> {
    if (!this.api || this.signal.aborted) { this.disabled = true; return; }
    this.suppressNotice = true;
    const opening = this.api('chat.startStream', { ...this.target, task_display_mode: 'plan' });
    // Retain a late successful timestamp even when the deadline/shutdown has already won.
    const tracked = opening.then(value => {
      const r = record(value);
      if (r.ok === true && typeof r.ts === 'string' && /^\d{1,16}\.\d{1,6}$/u.test(r.ts)) {
        this.ts = r.ts;
        if (this.abandoned || this.signal.aborted) void this.cleanup();
      }
      return value;
    });
    try {
      const response = await abortable(tracked, AbortSignal.any([this.signal, AbortSignal.timeout(SLACK_LIMITS.apiTimeoutMs)]));
      if (!accepted(response) || !this.ts) {
        this.disabled = true;
        if (unsupported.has(String(record(response).error))) this.suppressNotice = false;
      }
    } catch (error) {
      this.disabled = true; this.abandoned = true;
      const data = record(record(error).data);
      if (unsupported.has(String(data.error))) this.suppressNotice = false;
      await this.cleanup();
    }
    this.signal.throwIfAborted();
    if (this.disabled && this.suppressNotice) throw new Error('SLACK_STREAM_OPEN_FAILED');
  }
  progress = async (event: ChatProgress): Promise<void> => {
    this.signal.throwIfAborted();
    if (!this.ts || this.disabled || this.closed || this.events >= 48 ||
        !['in_progress', 'complete', 'error'].includes(event.state)) return;
    const title = Object.hasOwn(labels, event.toolName) ? labels[event.toolName] : undefined;
    if (!title || typeof event.toolCallId !== 'string' || !event.toolCallId || event.toolCallId.length > 256) return;
    let task = this.tasks.get(event.toolCallId);
    if (event.state === 'in_progress') {
      if (task || this.tasks.size >= 24) return;
      task = { id: `task-${this.tasks.size + 1}`, title, finished: false }; this.tasks.set(event.toolCallId, task);
    } else {
      if (!task || task.finished || task.title !== title) return;
      task.finished = true;
    }
    this.events++;
    try {
      const response = await this.call('chat.appendStream', { channel: this.target.channel, ts: this.ts,
        chunks: [{ type: 'task_update', id: task.id, title: task.title, status: event.state }] }, this.signal);
      if (!accepted(response)) this.disabled = true;
    } catch { this.disabled = true; this.signal.throwIfAborted(); }
  };
  async deliver(formatted: ReturnType<typeof formatSlack>): Promise<boolean> {
    this.signal.throwIfAborted();
    if (!this.ts) return false;
    if (this.closed || this.abandoned) throw new Error('SLACK_STREAM_CLOSED');
    // A stop write is never retried or followed by an ordinary answer, even on ambiguous failure.
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    const response = await this.call('chat.stopStream', { channel: this.target.channel, ts: this.ts,
      ...formatted }, this.signal);
    if (!accepted(response)) throw new Error('SLACK_STREAM_DELIVERY_FAILED');
    return true;
  }
  async cleanup(): Promise<void> {
    this.abandoned = true;
    if (!this.ts || this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    try { await this.call('chat.stopStream', { channel: this.target.channel, ts: this.ts }, AbortSignal.timeout(5_000)); }
    catch { /* At most one bounded cleanup write; no final text or dynamic logs. */ }
  }
  dispose(): void { this.signal.removeEventListener('abort', this.onAbort); }
}
