import { types } from "node:util";
import type { SlackReadClient } from "./client.js";
import type { CurrentSlackAccess } from "./authorization.js";
import { publicChannelId, verifiedChannelName } from "./schemas.js";
import { check, checkAuthorization, deny, errorResult, SlackReadAccessError, unavailable } from "./errors.js";

/** Optional display metadata must not execute getters, Proxy traps or coercion.
 * Run only AFTER the existing raw authority checks. Bad metadata is not a denial.
 */
function channelDisplayMetadata(channel: unknown): { name?: string } {
  try {
    if (channel === null || typeof channel !== "object" || types.isProxy(channel)) return {};
    const descriptor = Object.getOwnPropertyDescriptor(channel, "name");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        descriptor.value.length === 0 || descriptor.value.length > 80) return {};
    const name = verifiedChannelName.safeParse(descriptor.value);
    return name.success ? { name: name.data } : {};
  } catch { return {}; }
}

/** Operation-local only: call after live origin authorization/auth.test, never cache a grant.
 * RTS action_token-filtered results authorize requester search access; bot membership is NOT required.
 * This verifies public, installed-workspace, nonshared provenance, not full-thread access.
 */
async function verifiedPublicChannel(client: SlackReadClient, origin: CurrentSlackAccess, id: string) {
  try {
    if (!publicChannelId.safeParse(id).success) deny();
    const info = await client.conversations.info({ channel: id }); checkAuthorization(info);
    const channel = info.channel;
    if (!channel || channel.id !== id || channel.context_team_id !== origin.identity.teamId ||
        channel.is_channel !== true || channel.is_private !== false || channel.is_group !== false ||
        channel.is_im || channel.is_mpim || channel.is_ext_shared || channel.is_org_shared || channel.is_shared) deny();
    return { channel }; // Never return a raw object through Promise thenable assimilation.
  } catch (error) { throw new SlackReadAccessError(errorResult(error)); }
}

/** Search access is native RTS-filtered; public provenance validation precedes optional metadata. */
export async function verifyPublicSlackChannel(client: SlackReadClient, origin: CurrentSlackAccess, id: string): Promise<{ name?: string }> {
  return channelDisplayMetadata((await verifiedPublicChannel(client, origin, id)).channel);
}

/** Conservative bot-native full-thread policy, separate from native RTS search permission.
 * Live bounded requester membership on EVERY page; no snippets/capabilities/auto-join fallback.
 */
export async function authorizePublicSlackThread(client: SlackReadClient, origin: CurrentSlackAccess, id: string): Promise<{ name?: string }> {
  const { channel } = await verifiedPublicChannel(client, origin, id);
  try {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const members = await client.conversations.members({ channel: id, limit: 200, ...(cursor ? { cursor } : {}) });
      check(members);
      if (!Array.isArray(members.members) || members.members.length > 200 ||
          members.members.some(member => !/^[UW][A-Z0-9]{1,63}$/.test(member)) ||
          members.response_metadata?.warnings?.length || (members as { warning?: string }).warning) unavailable();
      if (members.members.includes(origin.identity.userId)) return channelDisplayMetadata(channel);
      const next = members.response_metadata?.next_cursor?.trim();
      if (!next || seen.has(next)) deny();
      seen.add(next); cursor = next;
    }
    deny();
  } catch (error) { throw new SlackReadAccessError(errorResult(error)); }
}
