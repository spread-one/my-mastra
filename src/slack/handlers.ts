import { createSlackInvocationContext } from './request.js';
import { authorizeCurrentSlackChannel, type SlackReadClient } from '../tools/slack/index.js';
import { scopedSlackClient } from '../tools/slack/transport.js';
import { projectFileCandidates, type FileCandidate } from './files.js';
import { HistoryError, type HistoryStore } from './history/index.js';
import { createHash } from 'node:crypto';
import type { Chat, ChatMessage } from '../chat.js';
import { budgetSlackThread, contextBytes, eventMessage, readSlackThread, removeOwnMention, validTs, type RepliesClient, type Summarize } from './context.js';
import { formatSlack, sanitizeSlackSource, sanitizeSlackDataMessage, OUTPUT_LIMIT_TEXT } from './format.js';
import { bytes, SLACK_LIMITS as limits, SlackBusyError, SlackCancelledError, SlackContextError, SlackInputError, slackCall } from './limits.js';
import { DmCache, SlackRuntime } from './runtime.js';
import { SlackPlan, type StreamApi } from './streaming.js';

export const CONTEXT_ERROR_TEXT = '스레드 전체 맥락을 확인하지 못해 답변하지 않았습니다. 새 멘션으로 다시 시도하거나 관리자에게 채널 접근·history 권한을 확인해 달라고 요청해주세요.';
export const HISTORY_ERROR_TEXT = '대화 저장소를 확인하지 못해 답변하지 않았습니다. 관리자에게 대화 저장소 복구를 요청해주세요.';
export const GENERAL_ERROR_TEXT = '요청을 안전하게 처리하지 못했습니다. 잠시 후 새 메시지로 다시 시도해주세요.';
export type SafeLog = (code: 'run_failed' | 'delivery_failed' | 'transport_error' | 'started' | 'stopped' | 'startup_failed') => void;
export type SlackPost = ReturnType<typeof formatSlack> & { channel: string; thread_ts: string };
export interface SlackClient extends RepliesClient { chat: { postMessage: (args: SlackPost) => Promise<unknown> }; apiCall?: StreamApi }
export type EventKind = 'app_mention' | 'message';
export interface HandlerDeps {
  client: SlackClient; chat: Chat; summarize: Summarize; runtime?: SlackRuntime; cache?: DmCache; history?: HistoryStore; readClient?: SlackReadClient;
  secrets?: readonly string[]; log?: SafeLog;
}
type TrustedEvent = { team: string; channel: string; root: string; current: string; user: string; botUser: string; botId?: string; id: string; text: string; rawText: string; oversized: boolean; dm: boolean; files: FileCandidate[]; subtype?: string; actionToken?: unknown };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,63}$/u.test(value);
function parseEvent(kind: EventKind, raw: unknown, body: unknown, context: unknown): TrustedEvent | undefined {
  const event = object(raw), envelope = object(body), trusted = object(context);
  const team = envelope.team_id ?? trusted.teamId;
  if (!id(team) || !id(event.channel) || !id(event.user) || !id(trusted.botUserId) || event.user === trusted.botUserId ||
      event.bot_id || event.bot_profile || (event.subtype !== undefined && event.subtype !== 'file_share') || event.hidden || !validTs(event.ts) ||
      (event.text !== undefined && typeof event.text !== 'string') ||
      (event.thread_ts !== undefined && !validTs(event.thread_ts))) return;
  if (!/^T[A-Z0-9]{1,63}$/u.test(team) || !/^[CGD][A-Z0-9]{1,63}$/u.test(event.channel) ||
      !/^[UW][A-Z0-9]{1,63}$/u.test(event.user) || !/^[UW][A-Z0-9]{1,63}$/u.test(trusted.botUserId)) return;
  if (typeof event.thread_ts === 'string') {
    const tsNumber = (ts: string) => BigInt(ts.split('.')[0]!) * 1_000_000n + BigInt(ts.split('.')[1]!.padEnd(6, '0'));
    if (tsNumber(event.thread_ts) > tsNumber(event.ts)) return;
  }
  const dm = event.channel_type === 'im' && event.channel.startsWith('D');
  if (kind === 'message' ? !dm : dm || event.channel.startsWith('D')) return;
  let files: FileCandidate[];
  try { files = projectFileCandidates(event.files, event.ts, event.thread_ts as string | undefined); } catch { return; }
  if ((event.text === undefined || event.subtype === 'file_share') && !files.length) return;
  const rawText = (event.text as string | undefined) ?? '';
  const root = (event.thread_ts as string | undefined) ?? event.ts;
  const request = typeof envelope.event_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(envelope.event_id)
    ? envelope.event_id : createHash('sha256').update(JSON.stringify([event.channel, event.ts, event.user])).digest('hex');
  const oversized = bytes(rawText) + bytes(JSON.stringify(files)) > limits.inputBytes;
  // Do not retain oversized event bodies while waiting in the bounded queue.
  return { team, channel: event.channel, root, current: event.ts, user: event.user,
    botUser: trusted.botUserId, ...(id(trusted.botId) ? { botId: trusted.botId } : {}),
    id: JSON.stringify([team, request]), text: oversized ? '' : removeOwnMention(rawText, trusted.botUserId),
    rawText: oversized ? '' : rawText, oversized, dm, files: oversized ? [] : files,
    ...(event.subtype === 'file_share' ? { subtype: 'file_share' } : {}),
    actionToken: typeof event.action_token === 'string' && event.action_token.length <= 16_384 ? event.action_token : undefined };
}

export function createSlackHandlers(deps: HandlerDeps) {
  const runtime = deps.runtime ?? new SlackRuntime();
  const cache = deps.cache ?? new DmCache();
  let stopped = false;
  // Rejected invocations must not bypass admission by spawning unlimited error API calls.
  // No notice queue; drop excess notices (or simultaneous same-thread notices) during overload.
  const notices = new Map<string, AbortController>();
  const log = deps.log ?? (() => {});
  const post = async (event: TrustedEvent, text: string, signal: AbortSignal, formatted = formatSlack(text, deps.secrets)) => {
    signal.throwIfAborted();
    const response = object(await slackCall(() => deps.client.chat.postMessage({ channel: event.channel, thread_ts: event.root,
      ...formatted }), signal));
    if (response.ok !== true || response.error || response.warning || (object(response.response_metadata).warnings as unknown[] | undefined)?.length) throw new Error('SLACK_DELIVERY_FAILED');
  };
  async function receive(kind: EventKind, raw: unknown, body: unknown, context: unknown): Promise<void> {
    if (stopped) return;
    const event = parseEvent(kind, raw, body, context);
    if (!event || (!event.text && !event.files.length && event.dm && !event.oversized)) return;
    const key = JSON.stringify([event.team, event.channel, event.root]);
    const invocationSecrets = [...(deps.secrets ?? []), ...(typeof event.actionToken === 'string' && event.actionToken
      ? [event.actionToken, JSON.stringify(event.actionToken).slice(1, -1)] : [])];
    let plan: SlackPlan | undefined;
    try {
      await runtime.run(event.id, key, async signal => {
        const deliver = async (text: string, formatted = formatSlack(text, deps.secrets)) => {
          if (!await plan!.deliver(formatted)) await post(event, text, signal, formatted);
        };
        try {
          if (event.oversized) throw new SlackInputError();
          const metadata = { teamId: event.team, userId: event.user, channel: event.channel, threadTs: event.root,
            requestId: event.id, actionToken: event.actionToken };
          const requestContext = createSlackInvocationContext(metadata, signal);
          // Each automatic history page uses the same trusted invocation context and base physical
          // transport, but a fresh operation-local deadline/call budget; no wrapper crosses requests.
          const threadClient: RepliesClient = deps.readClient ? { conversations: { replies: async args => {
            const client = scopedSlackClient(deps.readClient!, requestContext);
            await authorizeCurrentSlackChannel(client, requestContext);
            return client.conversations.replies(args);
          } } } : deps.client;
          let messages: ChatMessage[];
          if (!event.dm && event.root !== event.current) {
            messages = await budgetSlackThread(await readSlackThread(threadClient, { channel: event.channel, root: event.root,
              current: event.current, currentText: event.rawText, currentFiles: event.files, currentSubtype: event.subtype,
              user: event.user, botUser: event.botUser, botId: event.botId }, signal)
              .then(source => source.map(m => ({ ...m, content: sanitizeSlackDataMessage(m.content, invocationSecrets) }))), deps.summarize, signal);
          } else {
            messages = event.dm ? (deps.history ? await deps.history.get(key, signal) : cache.get(key)) : [];
            if (deps.history) {
              try {
                if (messages.some((m, i) => i % 2 === 0 && JSON.parse(m.content).author?.userId !== event.user)) throw new Error();
              } catch { throw new HistoryError('DATABASE'); }
            }
            const current = eventMessage(sanitizeSlackSource(event.text, deps.secrets), event.user, event.current, event.files);
            while (messages.length && contextBytes([...messages, current]) > limits.contextBytes) messages.splice(0, 2);
            messages.push(current);
            if (contextBytes(messages) > limits.contextBytes) throw new SlackInputError();
          }
          messages = messages.map(m => ({ ...m, content: sanitizeSlackDataMessage(m.content, invocationSecrets) }));
          signal.throwIfAborted();
          plan = new SlackPlan(deps.client.apiCall?.bind(deps.client), { channel: event.channel, thread_ts: event.root,
            recipient_team_id: event.team, recipient_user_id: event.user }, signal);
          await plan.open();
          const answer = !event.text && !event.files.length && event.root === event.current ? '네, 무엇을 도와드릴까요?' : await deps.chat(messages, signal, plan.progress,
            { ...metadata, requestContext });
          signal.throwIfAborted();
          const canonicalAnswer = sanitizeSlackSource(answer, invocationSecrets);
          let safeAnswer = canonicalAnswer;
          if (!safeAnswer.trim()) { await deliver(OUTPUT_LIMIT_TEXT); return; }
          const summarized = messages.some(message => message.content.includes('"source":"slack_thread_summary"'));
          if (summarized) safeAnswer = sanitizeSlackSource('참고: 오래된 스레드 댓글은 요약된 맥락으로 답변합니다.\n\n', deps.secrets) + canonicalAnswer;
          // Validate/render once, after the notice; canonical source stays Markdown.
          let formatted: ReturnType<typeof formatSlack>;
          try { formatted = formatSlack(safeAnswer); }
          catch { await deliver(OUTPUT_LIMIT_TEXT); return; }
          await deliver(safeAnswer, formatted);
          signal.throwIfAborted();
          if (event.dm) {
            const pairs: ChatMessage[] = [...messages, { role: 'assistant', content: canonicalAnswer }];
            if (deps.history) await deps.history.set(key, pairs, signal); else cache.set(key, pairs);
          }
        } catch (error) {
          // Do not mutate a corrupt store or destroy prior pairs on abort/shutdown.
          if (event.dm && !(error instanceof HistoryError) && !signal.aborted) {
            if (deps.history) await deps.history.delete(key, signal); else cache.delete(key);
          }
          throw error;
        } finally { await plan?.cleanup(); plan?.dispose(); }
      });
    } catch (error) {
      if (stopped) return;
      log('run_failed'); // Never accept dynamic error names/messages/objects or Slack text.
      const text = error instanceof HistoryError ? HISTORY_ERROR_TEXT : error instanceof SlackContextError ? CONTEXT_ERROR_TEXT : error instanceof SlackBusyError
        ? '현재 요청이 많습니다. 잠시 후 새 메시지로 다시 시도해주세요.' : error instanceof SlackInputError
        ? '메시지가 너무 깁니다. 내용을 나누어 보내주세요.' : error instanceof SlackCancelledError
        ? '요청 시간 제한을 초과해 답변하지 않았습니다. 더 짧은 질문으로 다시 시도해주세요.' : GENERAL_ERROR_TEXT;
      if (plan?.suppressNotice) return;
      // One separately bounded error notice outside the expired invocation; never an unbounded queue.
      if (notices.size >= limits.concurrency || notices.has(key)) return;
      const notice = new AbortController(); notices.set(key, notice);
      try { await post(event, text, AbortSignal.any([notice.signal, AbortSignal.timeout(5_000)])); }
      catch { if (!stopped) log('delivery_failed'); }
      finally { notices.delete(key); }
    }
  }
  let closing: Promise<void> | undefined;
  return { receive, shutdown: () => {
    stopped = true; runtime.shutdown(); cache.clear();
    for (const controller of notices.values()) controller.abort();
    notices.clear();
    return closing ??= runtime.settled().then(() => deps.history?.close());
  } };
}

export interface EventRegistrar { event: (name: EventKind, callback: (args: { event: unknown; body: unknown; context: unknown }) => Promise<void>) => unknown }
export function registerSlackHandlers(app: EventRegistrar, deps: HandlerDeps) {
  const handlers = createSlackHandlers(deps);
  app.event('app_mention', ({ event, body, context }) => handlers.receive('app_mention', event, body, context));
  app.event('message', ({ event, body, context }) => handlers.receive('message', event, body, context));
  return handlers;
}
