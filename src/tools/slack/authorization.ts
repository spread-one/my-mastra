import { scopedSlackClient } from "./transport.js";
import type { SlackReadClient } from "./client.js";
import { getSlackSearchActionToken, getSlackReadIdentity, type SlackReadIdentity } from "./context.js";
import { channelId, slackTs } from "./schemas.js";
import { check, checkAuthorization, deny, errorResult, invalid, SlackReadAccessError, unavailable } from "./errors.js";

export function requireSlackReadIdentity(context?: object): SlackReadIdentity {
  const identity = getSlackReadIdentity(context);
  if (!identity || !/^[UW][A-Z0-9]{1,63}$/.test(identity.userId) || !/^T[A-Z0-9]{1,63}$/.test(identity.teamId) ||
      !channelId.safeParse(identity.channel).success || !identity.requestId || !slackTs.safeParse(identity.threadTs).success) deny();
  return identity;
}
export type CurrentSlackAccess = Readonly<{
  identity: SlackReadIdentity; channelId: string; kind: "public_channel" | "private_channel" | "im";
  workspaceHost?: string;
}>;
/** Live check for EACH operation/page; the return value is not a reusable access capability. */
export async function authorizeCurrentSlackChannel(
  client: SlackReadClient, context: object | undefined, target: { channelId?: string; workspaceHost?: string } = {},
): Promise<CurrentSlackAccess> {
  try {
    client = scopedSlackClient(client, context);
    const identity = requireSlackReadIdentity(context);
    const id = target.channelId ?? identity.channel;
    if (id !== identity.channel) deny();
    const auth = await client.auth.test(); checkAuthorization(auth);
    if (!auth.bot_id || auth.team_id !== identity.teamId) deny();
    let workspaceHost: string | undefined;
    try {
      const url = new URL(auth.url!);
      if (url.protocol === "https:" && /^[a-z0-9-]+\.slack\.com$/.test(url.hostname)) workspaceHost = url.hostname;
    } catch { /* URLs are optional unless validating a permalink/search provenance. */ }
    if (target.workspaceHost && target.workspaceHost !== workspaceHost) deny();
    const info = await client.conversations.info({ channel: id }); checkAuthorization(info);
    const channel = info.channel as (NonNullable<typeof info.channel> & { user?: string }) | undefined;
    if (!channel || channel.id !== id || (channel.context_team_id && channel.context_team_id !== identity.teamId) ||
        channel.is_ext_shared || channel.is_org_shared || channel.is_shared) deny();
    if (id.startsWith("D")) {
      if (!channel.is_im || channel.user !== identity.userId) deny();
      return Object.freeze({ identity, channelId: id, kind: "im", workspaceHost });
    }
    if (!(channel.is_channel || channel.is_group) || channel.is_im || channel.is_mpim) deny();
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const members = await client.conversations.members({ channel: id, limit: 200, ...(cursor ? { cursor } : {}) });
      checkAuthorization(members);
      if (!Array.isArray(members.members) || members.members.length > 200 ||
          members.members.some(member => !/^[UW][A-Z0-9]{1,63}$/.test(member))) unavailable();
      if (members.members.includes(identity.userId)) return Object.freeze({ identity, channelId: id,
        kind: channel.is_private === false && !channel.is_group ? "public_channel" : "private_channel", workspaceHost });
      const next = members.response_metadata?.next_cursor?.trim();
      if (!next || seen.has(next)) deny();
      seen.add(next); cursor = next;
    }
    return deny();
  } catch (error) { throw new SlackReadAccessError(errorResult(error)); }
}
export type AuthorizedSlackMessage = Readonly<{
  channelId: string; messageTs: string; threadTs?: string; fileIds: readonly string[];
}>;
/** Exact current-channel message lookup for file/message provenance. No file metadata, URLs or downloads. */
export async function readAuthorizedSlackMessage(
  client: SlackReadClient, context: object | undefined,
  target: { messageTs: string; threadTs?: string; channelId?: string },
): Promise<AuthorizedSlackMessage> {
  try {
    client = scopedSlackClient(client, context);
    if (!slackTs.safeParse(target.messageTs).success || (target.threadTs !== undefined &&
        (!slackTs.safeParse(target.threadTs).success || BigInt(target.threadTs.replace(".", "")) > BigInt(target.messageTs.replace(".", ""))))) invalid();
    const access = await authorizeCurrentSlackChannel(client, context, { channelId: target.channelId });
    const args = { channel: access.channelId, oldest: target.messageTs, latest: target.messageTs, inclusive: true };
    const response = target.threadTs
      ? await client.conversations.replies({ ...args, ts: target.threadTs, limit: 15 })
      : await client.conversations.history({ ...args, limit: 1 });
    check(response);
    if (!Array.isArray(response.messages) || response.messages.length > (target.threadTs ? 15 : 1) ||
        response.has_more || response.response_metadata?.next_cursor?.trim() || response.response_metadata?.warnings?.length ||
        (response as { warning?: string }).warning) unavailable();
    const matches = response.messages.filter(m => m.ts === target.messageTs);
    if (matches.length !== 1) invalid();
    for (const raw of response.messages) {
      const m = raw as typeof raw & { channel?: string; team?: string };
      if (!slackTs.safeParse(m.ts).success || (m.channel !== undefined && m.channel !== access.channelId) ||
          (m.team !== undefined && m.team !== access.identity.teamId) ||
          (target.threadTs && m.ts !== target.threadTs && m.thread_ts !== target.threadTs) ||
          (target.threadTs && m.thread_ts !== undefined && m.thread_ts !== target.threadTs) ||
          (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success)) unavailable();
      if (!target.threadTs && m.thread_ts && m.thread_ts !== target.messageTs) invalid(); // exact reply requires its parent
    }
    const message = matches[0]!;
    if (message.files !== undefined && !Array.isArray(message.files)) unavailable();
    const files = message.files ?? [];
    if (files.length > 100 || files.some(file => !/^F[A-Z0-9]{1,63}$/.test(file.id ?? ""))) unavailable();
    const actionToken = getSlackSearchActionToken(context);
    if (actionToken && JSON.stringify([access.channelId, target.messageTs, message.thread_ts, files.map(file => file.id)]).includes(actionToken)) unavailable();
    return Object.freeze({ channelId: access.channelId, messageTs: target.messageTs,
      ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
      fileIds: Object.freeze([...new Set(files.map(file => file.id!))]) });
  } catch (error) { throw new SlackReadAccessError(errorResult(error)); }
}
