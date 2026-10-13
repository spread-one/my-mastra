import { scopedSlackClient } from "./transport.js";
import { displayName, enrichAuthors } from './display.js';
import { createHash, randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { getSlackExecutionSignal, getSlackSearchActionToken, type SlackReadIdentity } from "./context.js";
import { authorizeCurrentSlackChannel, requireSlackReadIdentity } from "./authorization.js";
import { check, deny, invalid, unavailable, errorResult, readLimits as limits } from "./errors.js";
import { channelInput, threadInput, publicChannelId, slackTs, type ReadResult } from "./schemas.js";
import { SlackSearcher } from "./search.js";
import { jsonTextPrefix } from "./projection.js";
import { authorizePublicSlackThread } from "./public-authorization.js";

export type SlackReadClient = Pick<WebClient, "auth" | "conversations"> & Partial<Pick<WebClient, "apiCall" | "users" | "bots">>;
function timestamp(ts: string) { return BigInt(ts.replace(".", "")); }
type Target = { channel: string; threadTs?: string; host?: string };
type Continuation = { binding: string; slackCursor: string; page: number;
  rootReplyCount?: number; lossy: boolean; seen: string[]; fingerprints: Record<string, string>;
  expires: number; usedCursors: string[] };

/** Explicit public cross-channel threads; channel history stays current-only. No user token/join/scan fallback. */
export class SlackReader {
  private readonly cursors = new Map<string, Continuation>();
  private readonly inFlightCursors = new Set<string>();
  private readonly searcher: SlackSearcher;
  constructor(private readonly client: SlackReadClient, private readonly displaySecrets: readonly string[] = []) { this.searcher = new SlackSearcher(client, displaySecrets); }

  private target(input: { channel?: string; ts?: string; url?: string }, identity: SlackReadIdentity, thread: boolean): Target {
    let channel = input.channel ?? identity.channel, threadTs = input.ts, host: string | undefined;
    if (input.url) {
      let url: URL;
      try { url = new URL(input.url); } catch { return invalid(); }
      const match = /^\/archives\/([CGD][A-Z0-9]{1,63})\/p([0-9]{7,22})$/.exec(url.pathname);
      if (url.href !== input.url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
          !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !match) invalid();
      if ([...url.searchParams.keys()].some(k => !["thread_ts", "cid"].includes(k)) ||
          url.searchParams.getAll("thread_ts").length > 1 || url.searchParams.getAll("cid").length > 1) invalid();
      const ts = `${match[2]!.slice(0, -6)}.${match[2]!.slice(-6)}`;
      const parent = url.searchParams.get("thread_ts") ?? ts;
      if (!slackTs.safeParse(ts).success || !slackTs.safeParse(parent).success || timestamp(parent) > timestamp(ts) ||
          (url.searchParams.has("cid") && url.searchParams.get("cid") !== match[1]) ||
          (input.channel && input.channel !== match[1]) || (input.ts && input.ts !== parent)) invalid();
      channel = match[1]!; threadTs = parent; host = url.hostname;
    }
    if (channel !== identity.channel && (!thread || !publicChannelId.safeParse(channel).success)) deny();
    if (thread && !threadTs) invalid();
    return { channel, ...(thread ? { threadTs } : {}), ...(host ? { host } : {}) };
  }
  async search(input: unknown, context?: object): Promise<ReadResult> { return this.searcher.search(input, context); }
  async read(kind: "thread" | "channel", input: unknown, context?: object): Promise<ReadResult> {
    let lockedCursor: string | undefined;
    try {
      const client = scopedSlackClient(this.client, context);
      const identity = requireSlackReadIdentity(context);
      const parsed = (kind === "thread" ? threadInput : channelInput).safeParse(input);
      if (!parsed.success) invalid();
      const target = this.target(parsed.data, identity, kind === "thread");
      const binding = JSON.stringify([identity.teamId, identity.userId, identity.channel, identity.requestId, identity.threadTs, kind, target.channel, target.threadTs ?? null]);
      const actionToken = getSlackSearchActionToken(context);
      if (actionToken && binding.includes(actionToken)) deny();
      for (const [key, state] of this.cursors) if (state.expires < Date.now()) this.cursors.delete(key);
      const previous = parsed.data.cursor ? this.cursors.get(parsed.data.cursor) : undefined;
      if (parsed.data.cursor && (!previous || previous.binding !== binding || previous.page >= limits.maxPages || this.inFlightCursors.has(parsed.data.cursor))) invalid();
      if (parsed.data.cursor) {
        lockedCursor = parsed.data.cursor;
        this.inFlightCursors.add(lockedCursor);
      }
      const origin = await authorizeCurrentSlackChannel(client, context, { workspaceHost: target.host });
      const channelName = displayName(target.channel !== identity.channel
        ? (await authorizePublicSlackThread(client, origin, target.channel)).name : origin.channelName, [...this.displaySecrets, actionToken ?? '']);
      const display = channelName ? { channelName } : {};
      const cursor = previous?.slackCursor;
      // Observed replies pages include the parent in addition to requested replies.
      // Reserve its slot on every page; the published response bound stays unchanged.
      const args = { channel: target.channel, limit: kind === "thread" ? limits.pageSize - 1 : limits.pageSize, ...(cursor ? { cursor } : {}) };
      const response = kind === "thread"
        ? await client.conversations.replies({ ...args, ts: target.threadTs! })
        : await client.conversations.history(args);
      check(response);
      // Preserve short-circuit order and property access counts.
      if ((response as { warning?: string }).warning) unavailable();
      if (response.response_metadata?.warnings?.length) unavailable();
      if (!Array.isArray(response.messages)) unavailable();
      if (response.messages.length > limits.pageSize) unavailable();
      const messages: ReadResult["messages"] = [];
      const seen = new Set(previous?.seen ?? []);
      const fingerprints = { ...(previous?.fingerprints ?? {}) };
      let budget = limits.maxPageBytes - 2_048, lossy = previous?.lossy ?? false;
      let rootReplyCount = previous?.rootReplyCount;
      for (const [index, raw] of response.messages.entries()) {
        const m = raw as typeof raw & { channel?: string; team?: string; subtype?: string };
        if (!slackTs.safeParse(m.ts).success) unavailable();
        if (typeof m.text !== "string") unavailable();
        if (m.channel !== undefined && m.channel !== target.channel) unavailable();
        if (m.team !== undefined && m.team !== identity.teamId) unavailable();
        if (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success) unavailable();
        if (m.user !== undefined && !/^[UW][A-Z0-9]{1,63}$/.test(m.user)) unavailable();
        if (m.bot_id !== undefined && !/^B[A-Z0-9]{1,63}$/.test(m.bot_id)) unavailable();
        if (kind === "thread") {
          if (m.ts !== target.threadTs && m.thread_ts !== target.threadTs) unavailable();
          if (m.thread_ts && m.thread_ts !== target.threadTs) unavailable();
          if (timestamp(m.ts!) < timestamp(target.threadTs!)) unavailable();
        }
        if (kind === "thread" && m.ts === target.threadTs) {
          if (m.reply_count !== undefined && (!Number.isSafeInteger(m.reply_count) || m.reply_count < 0)) unavailable();
          // A plain, unthreaded message can omit reply_count. Infer zero only for a single terminal first page.
          const count = m.reply_count ?? (!previous && !m.thread_ts && response.messages.length === 1 &&
            !response.has_more && !response.response_metadata?.next_cursor?.trim() ? 0 : undefined);
          if (rootReplyCount !== undefined && count !== undefined && rootReplyCount !== count) lossy = true;
          rootReplyCount = count ?? rootReplyCount;
        }
        const fingerprint = createHash("sha256").update(JSON.stringify([m.ts, m.thread_ts, m.text, m.user, m.bot_id])).digest("hex");
        if (seen.has(m.ts!)) {
          if (fingerprints[m.ts!] !== fingerprint) unavailable();
          continue;
        }
        fingerprints[m.ts!] = fingerprint;
        seen.add(m.ts!);
        const safeText = actionToken ? m.text.split(actionToken).join("[SLACK_ACTION_TOKEN_REDACTED]") : m.text;
        const text = jsonTextPrefix(safeText, Math.min(8_000, Math.max(0, budget - 512 * (response.messages.length - index))));
        const textTruncated = text !== m.text;
        const message: ReadResult["messages"][number] = { channel: target.channel, ...display, ts: m.ts!,
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
          author: { userId: m.user ?? null, botId: m.bot_id ?? null, kind: m.bot_id || m.subtype === "bot_message" ? "bot" : m.user ? "participant" : "system" },
          text, textTruncated, ...(Number.isSafeInteger(m.reply_count) && m.reply_count! >= 0 ? { replyCount: m.reply_count } : {}),
        };
        budget -= Buffer.byteLength(JSON.stringify(message));
        if (budget < 0) unavailable();
        messages.push(message); lossy ||= textTruncated;
      }
      if (kind === "thread" && !seen.has(target.threadTs!)) unavailable();
      messages.sort((a, b) => timestamp(a.ts) < timestamp(b.ts) ? -1 : timestamp(a.ts) > timestamp(b.ts) ? 1 : 0);
      await enrichAuthors(client, messages.map(m => m.author), [...this.displaySecrets, actionToken ?? ''], getSlackExecutionSignal(context));
      // Account for escaped display metadata and reserve the source/status/cursor envelope.
      let textBudget = limits.maxPageBytes - 2_048 - Buffer.byteLength(JSON.stringify(messages.map(m => ({ ...m, text: '' }))));
      if (textBudget < 0) unavailable();
      for (const m of messages) {
        const text = jsonTextPrefix(m.text, textBudget);
        if (text !== m.text) { m.textTruncated = true; lossy = true; }
        m.text = text;
        textBudget -= Buffer.byteLength(JSON.stringify(text)) - 2;
      }
      const next = response.response_metadata?.next_cursor?.trim();
      if (actionToken && next?.includes(actionToken)) unavailable();
      if (actionToken && JSON.stringify(messages).includes(actionToken)) unavailable();
      const hasMore = !!next || !!response.has_more;
      const page = (previous?.page ?? 0) + 1;
      let nextCursor: string | null = null;
      if (next && (next === cursor || previous?.usedCursors.includes(next))) unavailable();
      if (next && page < limits.maxPages) nextCursor = randomUUID();
      const complete = !hasMore && !lossy && (kind !== "thread" || seen.size === rootReplyCount! + 1);
      const output: ReadResult = { status: "ok", message: complete ? "조회 범위를 모두 읽었습니다." : "부분 조회입니다. 다음 페이지·메시지 잘림·누락 가능성을 확인해주세요.",
        source: { channel: target.channel, ...display, ...(target.threadTs ? { threadTs: target.threadTs } : {}) },
        messages, page, nextCursor, complete, truncated: !complete, limits };
      if (Buffer.byteLength(JSON.stringify(output)) > limits.maxPageBytes) unavailable();
      if (nextCursor) {
        if (this.cursors.size >= 1000) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(nextCursor, { binding, slackCursor: next!, page,
          rootReplyCount, lossy, seen: [...seen], fingerprints, expires: Date.now() + 10 * 60_000,
          usedCursors: [...(previous?.usedCursors ?? []), next!] });
      }
      if (parsed.data.cursor) this.cursors.delete(parsed.data.cursor);
      return output;
    } catch (error) {
      return errorResult(error);
    }
    finally { if (lockedCursor) this.inFlightCursors.delete(lockedCursor); }
  }
}
