import { createHash } from 'node:crypto';
import type { Chat, ChatMessage } from '../chat.js';
import { budgetSlackThread, contextBytes, eventMessage, readSlackThread, removeOwnMention, validTs, type RepliesClient, type Summarize } from './context.js';
import { formatSlack, OUTPUT_LIMIT_TEXT } from './format.js';
import { bytes, SLACK_LIMITS as limits, SlackBusyError, SlackCancelledError, SlackContextError, SlackInputError, slackCall } from './limits.js';
import { DmCache, SlackRuntime } from './runtime.js';

export const CONTEXT_ERROR_TEXT = '스레드 전체 맥락을 확인하지 못해 답변하지 않았습니다. 새 멘션으로 다시 시도하거나 관리자에게 채널 접근·history 권한을 확인해 달라고 요청해주세요.';
export const GENERAL_ERROR_TEXT = '요청을 안전하게 처리하지 못했습니다. 잠시 후 새 메시지로 다시 시도해주세요.';
export type SafeLog = (code: 'run_failed' | 'delivery_failed' | 'transport_error' | 'started' | 'stopped' | 'startup_failed') => void;
export type SlackPost = ReturnType<typeof formatSlack> & { channel: string; thread_ts: string };
export interface SlackClient extends RepliesClient { chat: { postMessage: (args: SlackPost) => Promise<unknown> } }
export type EventKind = 'app_mention' | 'message';
export interface HandlerDeps {
  client: SlackClient; chat: Chat; summarize: Summarize; runtime?: SlackRuntime; cache?: DmCache;
  secrets?: readonly string[]; log?: SafeLog;
}
type TrustedEvent = { team: string; channel: string; root: string; current: string; user: string; botUser: string; botId?: string; id: string; text: string; rawText: string; oversized: boolean; dm: boolean };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,63}$/u.test(value);
function parseEvent(kind: EventKind, raw: unknown, body: unknown, context: unknown): TrustedEvent | undefined {
  const event = object(raw), envelope = object(body), trusted = object(context);
  const team = envelope.team_id ?? trusted.teamId;
  if (!id(team) || !id(event.channel) || !id(event.user) || !id(trusted.botUserId) || event.user === trusted.botUserId ||
      event.bot_id || event.subtype || event.hidden || !validTs(event.ts) || typeof event.text !== 'string' ||
      (event.thread_ts !== undefined && !validTs(event.thread_ts))) return;
  const dm = event.channel_type === 'im' && event.channel.startsWith('D');
  if (kind === 'message' ? !dm : dm || event.channel.startsWith('D')) return;
  const root = (event.thread_ts as string | undefined) ?? event.ts;
  const request = typeof envelope.event_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(envelope.event_id)
    ? envelope.event_id : createHash('sha256').update(JSON.stringify([event.channel, event.ts, event.user])).digest('hex');
  const oversized = bytes(event.text) > limits.inputBytes;
  // Do not retain oversized event bodies while waiting in the bounded queue.
  return { team, channel: event.channel, root, current: event.ts, user: event.user,
    botUser: trusted.botUserId, ...(id(trusted.botId) ? { botId: trusted.botId } : {}),
    id: JSON.stringify([team, request]), text: oversized ? '' : removeOwnMention(event.text, trusted.botUserId),
    rawText: oversized ? '' : event.text, oversized, dm };
}

export function createSlackHandlers(deps: HandlerDeps) {
  const runtime = deps.runtime ?? new SlackRuntime();
  const cache = deps.cache ?? new DmCache();
  let stopped = false;
  // Rejected invocations must not bypass admission by spawning unlimited error API calls.
  // No notice queue; drop excess notices (or simultaneous same-thread notices) during overload.
  const notices = new Map<string, AbortController>();
  const log = deps.log ?? (() => {});
  const post = async (event: TrustedEvent, text: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const response = object(await slackCall(() => deps.client.chat.postMessage({ channel: event.channel, thread_ts: event.root,
      ...formatSlack(text, deps.secrets) }), signal));
    if (response.ok !== true || response.error || response.warning || (object(response.response_metadata).warnings as unknown[] | undefined)?.length) throw new Error('SLACK_DELIVERY_FAILED');
  };
  async function receive(kind: EventKind, raw: unknown, body: unknown, context: unknown): Promise<void> {
    if (stopped) return;
    const event = parseEvent(kind, raw, body, context);
    if (!event || (!event.text && event.dm && !event.oversized)) return;
    const key = JSON.stringify([event.team, event.channel, event.root]);
    try {
      await runtime.run(event.id, key, async signal => {
        try {
          if (event.oversized) throw new SlackInputError();
          let messages: ChatMessage[];
          if (!event.dm && event.root !== event.current) {
            messages = await budgetSlackThread(await readSlackThread(deps.client, { channel: event.channel, root: event.root,
              current: event.current, currentText: event.rawText, user: event.user, botUser: event.botUser, botId: event.botId }, signal), deps.summarize, signal);
          } else {
            messages = event.dm ? cache.get(key) : [];
            const current = eventMessage(event.text, event.user, event.current);
            while (messages.length && contextBytes([...messages, current]) > limits.contextBytes) messages.splice(0, 2);
            messages.push(current);
            if (contextBytes(messages) > limits.contextBytes) throw new SlackInputError();
          }
          signal.throwIfAborted();
          const answer = !event.text && event.root === event.current ? '네, 무엇을 도와드릴까요?' : await deps.chat(messages, signal);
          signal.throwIfAborted();
          let safeAnswer: string;
          try {
            const formatted = formatSlack(answer, deps.secrets);
            safeAnswer = formatted.blocks.map(block => block.text.text).join('');
          } catch { await post(event, OUTPUT_LIMIT_TEXT, signal); return; }
          const summarized = messages.some(message => message.content.includes('"source":"slack_thread_summary"'));
          if (summarized) safeAnswer = '참고: 오래된 스레드 댓글은 요약된 맥락으로 답변합니다.\n\n' + safeAnswer;
          // Check after adding the notice; never silently truncate.
          try { formatSlack(safeAnswer, deps.secrets); }
          catch { await post(event, OUTPUT_LIMIT_TEXT, signal); return; }
          await post(event, safeAnswer, signal);
          signal.throwIfAborted();
          if (event.dm) cache.set(key, [...messages, { role: 'assistant', content: safeAnswer }]);
        } catch (error) {
          if (event.dm) cache.delete(key);
          throw error;
        }
      });
    } catch (error) {
      if (stopped) return;
      log('run_failed'); // Never accept dynamic error names/messages/objects or Slack text.
      const text = error instanceof SlackContextError ? CONTEXT_ERROR_TEXT : error instanceof SlackBusyError
        ? '현재 요청이 많습니다. 잠시 후 새 메시지로 다시 시도해주세요.' : error instanceof SlackInputError
        ? '메시지가 너무 깁니다. 내용을 나누어 보내주세요.' : error instanceof SlackCancelledError
        ? '요청 시간 제한을 초과해 답변하지 않았습니다. 더 짧은 질문으로 다시 시도해주세요.' : GENERAL_ERROR_TEXT;
      // One separately bounded error notice outside the expired invocation; never an unbounded queue.
      if (notices.size >= limits.concurrency || notices.has(key)) return;
      const notice = new AbortController(); notices.set(key, notice);
      try { await post(event, text, AbortSignal.any([notice.signal, AbortSignal.timeout(5_000)])); }
      catch { if (!stopped) log('delivery_failed'); }
      finally { notices.delete(key); }
    }
  }
  return { receive, shutdown: () => {
    stopped = true; runtime.shutdown(); cache.clear();
    for (const controller of notices.values()) controller.abort();
    notices.clear();
  } };
}

export interface EventRegistrar { event: (name: EventKind, callback: (args: { event: unknown; body: unknown; context: unknown }) => Promise<void>) => unknown }
export function registerSlackHandlers(app: EventRegistrar, deps: HandlerDeps) {
  const handlers = createSlackHandlers(deps);
  app.event('app_mention', ({ event, body, context }) => handlers.receive('app_mention', event, body, context));
  app.event('message', ({ event, body, context }) => handlers.receive('message', event, body, context));
  return handlers;
}
