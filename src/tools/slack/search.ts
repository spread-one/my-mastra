import { scopedSlackClient } from "./transport.js";
import { displayName, enrichAuthors } from './display.js';
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SlackReadClient } from "./client.js";
import { authorizeCurrentSlackChannel, requireSlackReadIdentity } from "./authorization.js";
import { getSlackExecutionSignal, getSlackSearchActionToken } from "./context.js";
import { check, deny, errorResult, failure, invalid, unavailable } from "./errors.js";
import { publicChannelId, searchInput, type ReadResult } from "./schemas.js";
import { jsonTextPrefix } from "./projection.js";
import { verifyPublicSlackChannel } from "./public-authorization.js";

// Slack's official RTS examples use variable fractional precision; canonicalize only validated API timestamps.
const apiTs = z.string().regex(/^[0-9]{1,16}\.[0-9]{1,6}$/).transform(ts => `${ts.split(".")[0]}.${ts.split(".")[1]!.padEnd(6, "0")}`);
const userId = z.string().regex(/^[UW][A-Z0-9]{1,63}$/);
const scopeFields = { channel_id: z.string().optional(), team_id: z.string().optional(), channel: z.string().optional(), team: z.string().optional() };
const contextMessage = z.object({ ...scopeFields, ts: apiTs, text: z.string(), user_id: userId.optional(), user: userId.optional(),
  is_author_bot: z.boolean().optional(), bot_id: z.string().regex(/^B[A-Z0-9]{1,63}$/).optional(), thread_ts: apiTs.optional() });
const searchMessage = z.object({ ...scopeFields, channel_id: publicChannelId, team_id: z.string(), message_ts: apiTs,
  content: z.string(), author_user_id: userId.optional(), is_author_bot: z.boolean(), permalink: z.string().max(512).optional(),
  thread_ts: apiTs.optional(), context_messages: z.object({ before: z.array(contextMessage).optional(), after: z.array(contextMessage).optional() }).optional(),
});
const responseSchema = z.object({ results: z.object({ messages: z.array(searchMessage).max(20),
  files: z.array(z.unknown()).max(0).optional(), channels: z.array(z.unknown()).max(0).optional(), users: z.array(z.unknown()).max(0).optional(),
}), response_metadata: z.object({ next_cursor: z.string().max(4096).optional(), warnings: z.array(z.string()).max(0).optional() }).optional(),
  next_cursor: z.string().max(4096).optional(), has_more: z.boolean().optional(), warning: z.string().optional(),
});

// Local processing safety limits, NOT Slack API shape or public output limits.
const processingLimits = { maxObservations: 2048, maxTextBytes: 1_048_576, maxMetadataUnits: 4096 };
const maxTextProjectionBytes = 24_000;

/**
 * Replace Zod's raw traversal with a fixed-shape, single-read snapshot. Budget checks
 * use those same reads: no raw serialization, enumeration, coercion, iterator,
 * toJSON or second getter/Proxy access. Zod only sees inert copies afterwards.
 * Unknown fields are irrelevant to validation and must never be traversed.
 */
function validationSnapshot(raw: unknown, exceedBudget: () => never): unknown {
  let observations = 0, textBytes = 0;
  type Project = (value: unknown) => unknown;
  const primitive: Project = value => {
    if (typeof value === "string" && value.length > processingLimits.maxMetadataUnits) exceedBudget();
    return value === null || ["undefined", "string", "boolean", "number"].includes(typeof value) ? value : null;
  };
  const text: Project = value => {
    if (typeof value !== "string") return primitive(value);
    // UTF-8 bytes >= JS code units, including lone surrogates. Reject before any scan.
    if (value.length > processingLimits.maxTextBytes - textBytes) exceedBudget();
    textBytes += Buffer.byteLength(value);
    if (textBytes > processingLimits.maxTextBytes) exceedBudget();
    return value;
  };
  const object = (shape: Record<string, Project>): Project => value => {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const copy: Record<string, unknown> = {};
    for (const [key, project] of Object.entries(shape)) copy[key] = project((value as Record<string, unknown>)[key]);
    return copy;
  };
  const messages = (item: Project, maximum: number): Project => value => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return null;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum ||
        length > processingLimits.maxObservations - observations) exceedBudget();
    observations += length; // Count all observations, not unique or selected messages.
    const copy: unknown[] = [];
    for (let i = 0; i < length; i++) copy.push(item(value[i]));
    return copy;
  };
  // These arrays must be empty. Do not traverse arbitrary malformed item payloads.
  const emptyArray: Project = value => value === undefined ? undefined : !Array.isArray(value) ? null : value.length === 0 ? [] : [null];
  const scope = { channel_id: primitive, team_id: primitive, channel: primitive, team: primitive };
  const contextual = object({ ...scope, ts: primitive, text, user_id: primitive, user: primitive,
    is_author_bot: primitive, bot_id: primitive, thread_ts: primitive });
  const primary = object({ ...scope, message_ts: primitive, content: text, author_user_id: primitive,
    is_author_bot: primitive, permalink: primitive, thread_ts: primitive,
    context_messages: object({ before: messages(contextual, processingLimits.maxObservations), after: messages(contextual, processingLimits.maxObservations) }) });
  return object({ results: object({ messages: messages(primary, 20), files: emptyArray, channels: emptyArray, users: emptyArray }),
    response_metadata: object({ next_cursor: primitive, warnings: emptyArray }),
    next_cursor: primitive, has_more: primitive, warning: primitive })(raw);
}
type DeliveryRole = "primary" | "context";
type RoleHashes = Partial<Record<DeliveryRole, string>>;
type SearchMessage = ReadResult["messages"][number];
// Guard knowledge is explicit parsed evidence, independent of the output author.kind projection.
type KindEvidence = { bot: boolean; participant: boolean };
type PageMetadata = { users: Set<string>; knownKinds: Set<string>; threads: Set<string> };
type State = { binding: string; cursor: string; page: number; lossy: boolean; fingerprints: Record<string, RoleHashes>;
  deliveredRoles: Record<string, DeliveryRole>; used: string[]; expires: number };
const limits = { pageSize: 20, maxPages: 4, maxPageBytes: 96_000 };
const messageKey = (message: SearchMessage) => JSON.stringify([message.channel, message.ts]);

/** Validate the message address before accepting navigation-only query hints. Never infer thread provenance. */
function normalizeSearchPermalink(url: URL, permalink: string, workspaceHost: string, channel: string,
  messageTs: string, threadTs: string | undefined): string | undefined {
  const path = `/archives/${channel}/p${messageTs.replace(".", "")}`;
  if (url.href !== permalink || url.protocol !== "https:" || url.hostname !== workspaceHost ||
      url.username || url.password || url.port || url.hash || url.pathname !== path) {
    return undefined;
  }
  // Preserve legacy queryless URLs, including bare ?/# delimiters and missing-link handling at the caller.
  if (!url.search) return permalink;
  try {
    const seen = new Set<string>();
    let steps = 0;
    for (const [key, value] of url.searchParams) {
      // The response schema still bounds the entire URL to 512 chars.
      if (++steps > 512 || (key !== "thread_ts" && key !== "cid") || seen.has(key) || !value) {
        return undefined;
      }
      seen.add(key);
      if (key === "cid") {
        if (value !== channel) return undefined;
      } else {
        const root = apiTs.safeParse(value);
        if (!root.success || BigInt(root.data.replace(".", "")) > BigInt(messageTs.replace(".", "")) ||
            (threadTs !== undefined && root.data !== threadTs)) {
          return undefined;
        }
      }
    }
    if (!steps) return undefined;
    // Query hints are validated then discarded; only the verified message address reaches the model.
    return `https://${workspaceHost}${path}`;
  } catch { return undefined; }
}

/** Bot + authenticated event action_token only. Native workspace-public keyword search, no fallback. */
export class SlackSearcher {
  private readonly cursors = new Map<string, State>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly client: SlackReadClient, private readonly displaySecrets: readonly string[] = []) {}
  async search(input: unknown, context?: object): Promise<ReadResult> {
    let locked: string | undefined;
    try {
      const client = scopedSlackClient(this.client, context);
      const identity = requireSlackReadIdentity(context);
      const parsed = searchInput.safeParse(input); if (!parsed.success) invalid();
      const { query, channel, cursor, limit } = parsed.data;
      const searchScope = channel ? "channel" : "workspace_public";
      // Do not interpret caller-controlled Slack operators. Literal quoted terms + optional structured in: filter.
      if (!/^[\p{L}\p{N}_ -]+$/u.test(query) || /(^|\s)(OR|AND|NOT)(\s|$)/i.test(query)) deny();
      const actionToken = getSlackSearchActionToken(context);
      if (!actionToken) { return { ...failure("unsupported", "검색용 Slack event action_token이 없습니다. 관리자에게 AI/Real-time Search 활성화·search:read.public 권한·app_mention/message event action_token 수신을 확인해주세요. 사용자 토큰 입력으로 대체하지 않습니다."), limits }; }
      const binding = JSON.stringify([identity.teamId, identity.userId, identity.channel, identity.requestId, identity.threadTs, searchScope, channel ?? null, query, limit]);
      if (binding.includes(actionToken)) deny();
      for (const [key, state] of this.cursors) if (state.expires <= Date.now()) this.cursors.delete(key);
      const previous = cursor ? this.cursors.get(cursor) : undefined;
      if (cursor && (!previous || previous.binding !== binding || previous.page >= limits.maxPages || this.inFlight.has(cursor))) invalid();
      if (cursor) { locked = cursor; this.inFlight.add(cursor); }
      const access = await authorizeCurrentSlackChannel(client, context);
      if (access.kind !== "public_channel") { return { ...failure("unsupported", "검색은 공개 채널에서 요청해야 합니다. private 채널·DM/MPIM에서의 검색은 지원하지 않습니다."), limits }; }
      if (!access.workspaceHost) unavailable();
      if (!client.apiCall) return { ...failure("unsupported", "Slack SDK에서 검색 API transport를 사용할 수 없습니다. 우회 조회하지 않습니다."), limits };
      // Page-local metadata checks only, <=20 unique primary channels. No reusable permission cache.
      const verified = new Map<string, string | undefined>();
      const verify = async (id: string) => {
        if (verified.has(id)) return;
        if (verified.size >= 20) unavailable();
        const { name } = await verifyPublicSlackChannel(client, access, id);
        // Display only, page-local and token-safe; never enters binding/identity/hash state.
        verified.set(id, name?.includes(actionToken) ? undefined : displayName(name, this.displaySecrets));
      };
      const display = (id: string) => {
        const channelName = verified.get(id);
        return channelName === undefined ? {} : { channelName };
      };
      if (channel) await verify(channel);
      const terms = query.trim().split(/\s+/).map(term => `"${term}"`).join(" ");
      // SDK lacks this new method's types: apiCall uses the documented endpoint/official argument names.
      const raw = await client.apiCall("assistant.search.context", {
        action_token: actionToken, query: channel ? `in:<#${channel}> ${terms}` : terms,
        channel_types: ["public_channel"], content_types: ["messages"], context_channel_id: identity.channel,
        include_bots: true, include_context_messages: true, include_message_blocks: false,
        disable_semantic_search: true, highlight: false, sort: "timestamp", sort_dir: "asc", limit,
        ...(previous ? { cursor: previous.cursor } : {}),
      });
      check(raw);
      const snapshot = validationSnapshot(raw, () => unavailable());
      const response = responseSchema.safeParse(snapshot);
      if (!response.success) unavailable();
      const data = response.data;
      if (data.warning || data.results.messages.length > limit) unavailable();
      const candidates: ReadResult["messages"] = [], contexts: ReadResult["messages"] = [];
      // Bounded page-local side metadata from parsed values only; never output or cursor state.
      const kindEvidence = new WeakMap<SearchMessage, KindEvidence>();
      const validateScope = (m: { channel_id?: string; channel?: string; team_id?: string; team?: string }, parent: string) => {
        if ((m.channel_id !== undefined && m.channel_id !== parent) || (m.channel !== undefined && m.channel !== parent) ||
            (m.team_id !== undefined && m.team_id !== identity.teamId) || (m.team !== undefined && m.team !== identity.teamId)) unavailable();
      };
      for (const m of data.results.messages) {
        validateScope(m, m.channel_id);
        if (m.thread_ts && BigInt(m.thread_ts.replace(".", "")) > BigInt(m.message_ts.replace(".", ""))) unavailable();
        if (channel && m.channel_id !== channel) unavailable();
        await verify(m.channel_id);
        let normalizedPermalink = m.permalink;
        if (m.permalink) {
          // Only schema-parsed values and the existing URL parse. Never inspect raw response metadata.
          const permalink = m.permalink;
          let url: URL; try { url = new URL(permalink); } catch { return unavailable(); }
          normalizedPermalink = normalizeSearchPermalink(url, permalink, access.workspaceHost!, m.channel_id, m.message_ts, m.thread_ts);
          if (normalizedPermalink === undefined) unavailable();
        }
        const primaryBot = m.is_author_bot, primaryUser = m.author_user_id;
        const candidate: SearchMessage = { channel: m.channel_id, ...display(m.channel_id), ts: m.message_ts, text: m.content, textTruncated: false,
          author: { userId: primaryUser ?? null, botId: null, kind: primaryBot ? "bot" : primaryUser ? "participant" : "system" },
          ...(m.thread_ts ? { threadTs: m.thread_ts } : {}), ...(normalizedPermalink ? { permalink: normalizedPermalink } : {}), searchMatch: true };
        candidates.push(candidate);
        kindEvidence.set(candidate, { bot: primaryBot, participant: !primaryBot });
        for (const position of ["before", "after"] as const) for (const c of m.context_messages?.[position] ?? []) {
          // Official contextual objects omit scope: they inherit the verified parent result's channel/team.
          // Any explicit scope, including alternate field names, must agree; never silently discard leaks.
          validateScope(c, m.channel_id);
          const contextTime = BigInt(c.ts.replace(".", "")), matchTime = BigInt(m.message_ts.replace(".", ""));
          if (c.thread_ts && BigInt(c.thread_ts.replace(".", "")) > contextTime) unavailable();
          if ((position === "before" && contextTime >= matchTime) || (position === "after" && contextTime <= matchTime)) unavailable();
          if (m.thread_ts && c.thread_ts && c.thread_ts !== m.thread_ts) unavailable();
          const contextBot = c.is_author_bot, contextBotId = c.bot_id, contextUser = c.user_id, alternateUser = c.user;
          const contextual: SearchMessage = { channel: m.channel_id, ...display(m.channel_id), ts: c.ts, text: c.text, textTruncated: false,
            author: { userId: contextUser ?? alternateUser ?? null, botId: contextBotId ?? null, kind: contextBot || contextBotId ? "bot" : contextUser || alternateUser ? "participant" : "system" },
            ...(c.thread_ts ? { threadTs: c.thread_ts } : {}), searchMatch: false, contextForTs: m.message_ts, contextPosition: position };
          contexts.push(contextual);
          // Explicit false is known participant even without a user; bot_id is only a presence signal.
          // Retain contradictory explicit signals as mixed, without changing the projected kind.
          kindEvidence.set(contextual, { bot: contextBot === true || contextBotId !== undefined, participant: contextBot === false });
        }
      }
      const fingerprints: Record<string, RoleHashes> = {};
      const deliveredRoles = { ...(previous?.deliveredRoles ?? {}) };
      // Validate ALL observations before selection, including omitted context. Clone role hashes:
      // failed continuation attempts must not mutate the seed. No page text enters cursor state.
      const observed = new Map<string, RoleHashes>(Object.entries(previous?.fingerprints ?? {}).map(([key, hashes]) => [key, { ...hashes }]));
      const pageObserved = new Map<string, Partial<Record<DeliveryRole, SearchMessage>>>();
      // Page-local primitives only. Missing metadata never removes an earlier explicit value.
      const pageMetadata = new Map<string, Partial<Record<DeliveryRole, PageMetadata>>>();
      // Same-role conflicts always fail, even exact prefixes or normalized-equivalent strings.
      for (const message of [...candidates, ...contexts]) {
        const role: DeliveryRole = message.searchMatch ? "primary" : "context";
        const fingerprint = createHash("sha256").update(message.text).digest("hex");
        const key = messageKey(message);
        const hashes = observed.get(key) ?? {};
        const pageRoles = pageObserved.get(key) ?? {};
        if (hashes[role] && hashes[role] !== fingerprint) unavailable();
        hashes[role] = fingerprint; observed.set(key, hashes);
        pageRoles[role] = message; pageObserved.set(key, pageRoles);
        const metadata = pageMetadata.get(key) ?? {};
        const roleMetadata = metadata[role] ?? { users: new Set<string>(), knownKinds: new Set<string>(), threads: new Set<string>() };
        if (message.author.userId) roleMetadata.users.add(message.author.userId);
        const evidence = kindEvidence.get(message);
        // Accumulate each object's validated flags; omission never erases knowledge.
        if (evidence?.bot) roleMetadata.knownKinds.add("bot");
        if (evidence?.participant) roleMetadata.knownKinds.add("participant");
        if (message.threadTs) roleMetadata.threads.add(message.threadTs);
        metadata[role] = roleMetadata; pageMetadata.set(key, metadata);
      }
      // Equivalent to comparing every primary with every context's explicit known metadata,
      // without an unbounded Cartesian scan. Unknown on either role remains a wildcard.
      const compatibleKnownValues = (primary: Set<string>, contextual: Set<string>) =>
        !primary.size || !contextual.size || (primary.size === 1 && contextual.size === 1 &&
          primary.values().next().value === contextual.values().next().value);
      const shortPrimary = new Set<string>();
      let lossy = previous?.lossy ?? false;
      for (const [key, pageRoles] of pageObserved) {
        const hashes = observed.get(key)!;
        if (!hashes.primary || !hashes.context || hashes.primary === hashes.context) continue;
        const primary = pageRoles.primary, contextual = pageRoles.context;
        // A known same-role hash is sufficient for an exact repeat. Cross-role-only
        // promotion/first observation still needs equal hashes or current-page evidence.
        if ((!primary || !contextual) && previous?.fingerprints[key]?.[primary ? "primary" : "context"]) continue;
        // Unequal cross-role seeds cannot justify discarding an alternate context without BOTH
        // validated page-local representations. Same-role seed comparisons above must also pass.
        const metadata = pageMetadata.get(key)!;
        // Preserve rejection order: presence → users → explicit kind → threads.
        if (!primary || !contextual) unavailable();
        if (!compatibleKnownValues(metadata.primary!.users, metadata.context!.users)) unavailable();
        if (!compatibleKnownValues(metadata.primary!.knownKinds, metadata.context!.knownKinds)) unavailable();
        if (!compatibleKnownValues(metadata.primary!.threads, metadata.context!.threads)) unavailable();
        // Keep the validated primary unchanged and omit the alternate context, not an
        // equivalence/authority claim. Unequal observed role hashes remain independent.
        lossy = true;
        // Only an exact prefix is evidence for the existing short-primary truncation marker.
        if (contextual!.text.startsWith(primary!.text)) shortPrimary.add(key);
      }
      const projected = new Map<string, SearchMessage>();
      for (const message of [...candidates, ...contexts]) {
        const role: DeliveryRole = message.searchMatch ? "primary" : "context";
        const key = messageKey(message);
        if (role === "primary" && shortPrimary.has(key)) { message.textTruncated = true; lossy = true; }
        // Context delivery is not proof of match delivery. Return the full primary object on promotion.
        if (deliveredRoles[key] === "primary" || (role === "context" && deliveredRoles[key] === "context")) continue;
        const selected = projected.get(key);
        if (selected && (selected.searchMatch || role === "context")) continue;
        if (!selected && projected.size >= 40) { lossy = true; continue; }
        projected.set(key, message); // primary wins; context keeps its first representative relation
      }
      const messages = [...projected.values()];
      const next = data.response_metadata?.next_cursor?.trim() || data.next_cursor?.trim();
      if (data.response_metadata?.next_cursor && data.next_cursor && data.response_metadata.next_cursor !== data.next_cursor) unavailable();
      if (next?.includes(actionToken)) unavailable();
      if (next && (next === previous?.cursor || previous?.used.includes(next))) unavailable();
      const page = (previous?.page ?? 0) + 1;
      const nextCursor = next && page < limits.maxPages ? randomUUID() : null;
      const result = (items: SearchMessage[], complete: boolean): ReadResult => ({
        status: "ok", api: "assistant.search.context", searchScope, ...(channel ? { source: { channel, ...display(channel) } } : {}),
        message: complete ? `${channel ? "지정한 공개 채널" : "워크스페이스 공개 채널"}의 키워드 검색 범위를 확인했습니다 (전체 기록이 아닙니다).` : "부분 검색 결과입니다. 다음 페이지와 본문 잘림 및 context 생략(대체 표현 포함)을 확인해주세요.",
        messages: items, page, nextCursor, complete, truncated: !complete, limits: { ...limits, pageSize: limit },
      });
      await enrichAuthors(client, messages.map(m => m.author), [...this.displaySecrets, actionToken], getSlackExecutionSignal(context));
      const primaryCount = messages.filter(m => m.searchMatch).length;
      // Reserve the ACTUAL JSON envelope: commas, brackets, limits, source, cursor,
      // Korean status text and boolean spellings. Both completion branches are covered.
      // Blank text copies ensure we never serialize an unbounded body to measure it.
      const headerBytes = () => {
        const headers = messages.map(m => ({ ...m, text: "" }));
        return Math.max(Buffer.byteLength(JSON.stringify(result(headers, true))), Buffer.byteLength(JSON.stringify(result(headers, false))));
      };
      let headers = headerBytes();
      while (headers > limits.maxPageBytes && messages.length > primaryCount) { messages.pop(); lossy = true; headers = headerBytes(); }
      let budget = limits.maxPageBytes - headers;
      if (budget < 0) unavailable();
      for (const message of messages) {
        const original = message.text;
        const safeText = original.split(actionToken).join("[SLACK_ACTION_TOKEN_REDACTED]");
        message.text = jsonTextPrefix(safeText, Math.min(maxTextProjectionBytes, budget));
        message.textTruncated ||= message.text !== original;
        lossy ||= message.textTruncated;
        budget -= Buffer.byteLength(JSON.stringify(message.text)) - 2;
      }
      messages.sort((a, b) => BigInt(a.ts.replace(".", "")) < BigInt(b.ts.replace(".", "")) ? -1 : a.ts === b.ts ? 0 : 1);
      const output = result(messages, !next && !data.has_more && !lossy);
      if (JSON.stringify(output).includes(actionToken)) unavailable();
      if (Buffer.byteLength(JSON.stringify(output)) > limits.maxPageBytes) unavailable();
      for (const message of messages) deliveredRoles[messageKey(message)] = message.searchMatch ? "primary" : "context";
      // Only actually delivered (channel,ts) keys, at most 40/page * 4 pages, with two hashes/key.
      // Store each role's original API hash, never the context hash as a primary delivery hash.
      for (const key of Object.keys(deliveredRoles)) fingerprints[key] = { ...observed.get(key)! };
      if (nextCursor) {
        if (this.cursors.size >= 1000) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(nextCursor, { binding, cursor: next!, page, lossy, fingerprints, deliveredRoles, used: [...(previous?.used ?? []), next!], expires: Date.now() + 10 * 60_000 });
      }
      if (cursor) this.cursors.delete(cursor);
      return output;
    } catch (error) {
      return { ...errorResult(error), limits };
    }
    finally { if (locked) this.inFlight.delete(locked); }
  }
}
