import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
const logger = console;
import { SlackReader, type SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readAuthorizedSlackMessage } from "./authorization.js";
import { channelInput, readOutput, threadInput } from "./schemas.js";

const token = "SYNTHETIC_CROSS_ACTION_SECRET";
const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const publicInfo = (id: string) => ({ id, context_team_id: "T1", is_channel: true, is_private: false, is_group: false, is_member: false });
const match = (channel: string, n = 2, text = `${channel} body`) => ({ channel_id: channel, team_id: "T1", message_ts: ts(n),
  content: text, is_author_bot: false, author_user_id: "U2", permalink: `https://synthetic.slack.com/archives/${channel}/p${ts(n).replace(".", "")}` });
function context(changes = {}) {
  const ctx = new RequestContext();
  bindSlackReadContext(ctx, { userId: "U1", teamId: "T1", channel: "C1", requestId: "cross-event", threadTs: "1700000000.000001", ...changes }, token);
  return ctx;
}
function fixture() {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn(async ({ channel }: { channel: string }): Promise<{ ok: boolean; channel: Record<string, unknown> }> => ({ ok: true, channel: publicInfo(channel) }));
  // Requester is deliberately NOT a member of target channels. Native RTS supplies search permission.
  const members = vi.fn(async ({ channel }: { channel: string }) => ({ ok: true, members: channel === "C1" ? ["U1"] : [] }));
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [match("C2"), match("C3")] } });
  const replies = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: ts(1), text: "target root", reply_count: 1 },
    { ts: ts(2), thread_ts: ts(1), text: "target reply" }] });
  const history = vi.fn(), join = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, replies, history, join }, apiCall } as unknown as SlackReadClient;
  return { reader: new SlackReader(client), client, auth, info, members, apiCall, replies, history, join, ctx: context() };
}
afterEach(() => {
  expect(vi.mocked(logger.info).mock.calls.filter(([name]) => name === "slack_cross_channel_search_diagnostic")).toEqual([]);
  vi.restoreAllMocks();
});

describe("workspace-public native RTS permission, actual source and live public validation (synthetic)", () => {
  it("searches 2 nonmember targets with no origin in filter and no fabricated origin source", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...match("C2"), context_messages: { before: [{ ts: ts(1), text: "C2 context" }] } }, match("C3"), match("C2"),
    ] } });
    const result = await f.reader.search({ query: "출시 좋아요" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", searchScope: "workspace_public", complete: true });
    expect(result.source).toBeUndefined(); expect(readOutput.safeParse(result).success).toBe(true);
    expect(result.messages.map(m => [m.channel, m.ts, m.text])).toEqual([["C2", ts(1), "C2 context"], ["C2", ts(2), "C2 body"], ["C3", ts(2), "C3 body"]]);
    expect(f.apiCall).toHaveBeenCalledWith("assistant.search.context", expect.objectContaining({
      action_token: token, context_channel_id: "C1", query: '"출시" "좋아요"', channel_types: ["public_channel"], include_bots: true,
    }));
    expect(f.info.mock.calls.map(([args]) => args.channel)).toEqual(["C1", "C2", "C3"]);
    expect(f.members).toHaveBeenCalledExactlyOnceWith({ channel: "C1", limit: 200 });
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled(); expect(f.join).not.toHaveBeenCalled();
  });
  it("scopes only the explicit public target, preserving trusted origin context and target source", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2")] } });
    expect(await f.reader.search({ query: "launch", channel: "C2" }, f.ctx)).toMatchObject({ status: "ok", searchScope: "channel", source: { channel: "C2" } });
    expect(f.apiCall).toHaveBeenCalledWith("assistant.search.context", expect.objectContaining({ query: 'in:<#C2> "launch"', context_channel_id: "C1" }));
    expect(f.info.mock.calls.map(([args]) => args.channel)).toEqual(["C1", "C2"]); // target reused only inside this page
    expect(f.members).toHaveBeenCalledTimes(1);
  });
  it.each([
    { is_private: true }, { is_private: undefined }, { is_group: true }, { is_group: undefined }, { is_channel: false },
    { is_im: true }, { is_mpim: true }, { is_shared: true }, { is_ext_shared: true }, { is_org_shared: true },
    { context_team_id: "TOTHER" }, { context_team_id: undefined }, { id: "COTHER" },
  ])("fails the entire page before exposing any body when one channel is not verified: %j", async overrides => {
    const f = fixture(); f.info.mockImplementation(async ({ channel }) => ({ ok: true, channel: { ...publicInfo(channel), ...(channel === "C3" ? overrides : {}) } }));
    const result = await f.reader.search({ query: "launch" }, f.ctx);
    expect(result).toMatchObject({ status: "access_denied", messages: [], complete: false, nextCursor: null });
    expect(JSON.stringify(result)).not.toContain("C2 body"); expect(JSON.stringify(result)).not.toContain("C3 body");
  });
  it.each([
    { channel_id: "GPRIVATE" }, { channel_id: "DOTHER" }, { channel_id: "bad" }, { channel: "C1" }, { team_id: "TOTHER" }, { team: "TOTHER" },
    { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", channel_id: "C3" }] } },
    { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", channel: "GPRIVATE" }] } },
    { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", team_id: "TOTHER" }] } },
    { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", team: "TOTHER" }] } },
    { permalink: match("C1").permalink }, { permalink: `${match("C2").permalink}?cid=C1` },
  ])("rejects aliases, context or actual permalink provenance mismatch: %j", async overrides => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C3"), { ...match("C2"), ...overrides }] } });
    expect(await f.reader.search({ query: "launch" }, f.ctx)).toMatchObject({ status: "unavailable", messages: [], complete: false });
  });
  it("rejects a verified but wrong scoped result and never uses query thread hints as parent provenance", async () => {
    const f = fixture();
    expect(await f.reader.search({ query: "launch", channel: "C2" }, f.ctx)).toMatchObject({ status: "unavailable", messages: [] });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match("C2"), permalink: `${match("C2").permalink}?thread_ts=${ts(1)}&cid=C2` }] } });
    const result = await f.reader.search({ query: "launch" }, f.ctx);
    expect(result).toMatchObject({ status: "ok", messages: [{ channel: "C2", permalink: match("C2").permalink }] });
    expect(result.messages[0]!.threadTs).toBeUndefined(); expect(result.source).toBeUndefined();
  });
  it.each([["not_in_channel", "access_denied"], ["missing_scope", "access_denied"], ["rate_limited", "rate_limited"], ["transport", "unavailable"]])("maps target info %s honestly without fallback", async (error, status) => {
    const f = fixture(); f.info.mockImplementation(async ({ channel }) => {
      if (channel !== "C1") throw { data: { error }, message: token };
      return { ok: true, channel: publicInfo(channel) };
    });
    expect(await f.reader.search({ query: "launch" }, f.ctx)).toMatchObject({ status, messages: [], complete: false });
    expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.join).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled();
  });
  it("maps a target metadata 429 with retry delay and denies scoped target before search SDK call", async () => {
    const f = fixture(); f.info.mockResolvedValueOnce({ ok: true, channel: publicInfo("C1") });
    f.info.mockRejectedValueOnce({ statusCode: 429, retryAfter: 37, message: token });
    expect(await f.reader.search({ query: "launch", channel: "C2" }, f.ctx)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 37, messages: [] });
    expect(f.apiCall).not.toHaveBeenCalled();
  });
  it("bounds page-local unique primary metadata at 20, with no cross-page authorization reuse", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: Array.from({ length: 20 }, (_, n) => match(`CTARGET${n}`)) }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.ctx);
    expect(first).toMatchObject({ status: "ok", page: 1 }); expect(first.messages).toHaveLength(20); expect(f.info).toHaveBeenCalledTimes(21); // plus strict origin
    f.info.mockClear(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("CTARGET0")] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "ok", messages: [], page: 2 });
    expect(f.info.mock.calls.map(([args]) => args.channel)).toEqual(["C1", "CTARGET0"]);
  });
});

describe("composite channel/ts identity, independent roles and opaque traversal", () => {
  it.each(["short longer", "UNRELATED_C2_CONTEXT"])("keeps differing text/actors/threads and alternate context independent at the same timestamp (%s)", async alternate => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...match("C2", 2, "short"), thread_ts: ts(1), is_author_bot: true, author_user_id: "UBOT" },
      { ...match("C3", 2, "entirely different"), thread_ts: ts(0), author_user_id: "UOTHER" },
      { ...match("C2", 4), context_messages: { before: [{ ts: ts(2), text: alternate, thread_ts: ts(1), is_author_bot: true, user_id: "UBOT" }] } },
      { ...match("C3", 4), context_messages: { before: [{ ts: ts(2), text: "entirely different", thread_ts: ts(0), is_author_bot: false, user_id: "UOTHER" }] } },
    ] }, next_cursor: "next-1" });
    const first = await f.reader.search({ query: "launch" }, f.ctx);
    expect(first).toMatchObject({ status: "ok", complete: false }); expect(first.messages).toHaveLength(4);
    expect(first.messages.find(m => m.channel === "C2" && m.ts === ts(2))).toMatchObject({ text: "short", textTruncated: alternate.startsWith("short"), author: { kind: "bot", userId: "UBOT" }, threadTs: ts(1) });
    expect(first.messages.find(m => m.channel === "C3" && m.ts === ts(2))).toMatchObject({ text: "entirely different", textTruncated: false, author: { kind: "participant", userId: "UOTHER" }, threadTs: ts(0) });
    const cursors = (f.reader as unknown as { searcher: { cursors: Map<string, { fingerprints: Record<string, object>; deliveredRoles: Record<string, string> }> } }).searcher.cursors;
    const seed = JSON.stringify(cursors.get(first.nextCursor!));
    const state = cursors.get(first.nextCursor!)!;
    expect(Object.keys(state.fingerprints).sort()).toEqual(first.messages.map(m => JSON.stringify([m.channel, m.ts])).sort());
    expect(Object.keys(state.deliveredRoles).sort()).toEqual(Object.keys(state.fingerprints).sort());
    for (const secret of ["short", "longer", alternate, "UBOT", "UOTHER", "entirely different", token]) expect(seed).not.toContain(secret);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("COTHER", 2, "new same ts"), match("C2", 2, "conflict")] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "unavailable", messages: [] });
    expect(JSON.stringify(cursors.get(first.nextCursor!))).toBe(seed); // failed attempt is immutable/unlocked
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("COTHER", 2, "new same ts"), match("C3", 2, "entirely different"), match("C2", 2, "short")] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "ok", page: 2, complete: false, messages: [{ channel: "COTHER", ts: ts(2), text: "new same ts" }] });
  });
  it("does not use another channel's context seed as same-role proof or hide its primary promotion", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      { ...match("C2", 4), context_messages: { before: [{ ts: ts(2), text: "C2 full" }] } }, match("C3", 2, "C3 body"),
    ] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch" }, f.ctx);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2", 2, "C2"), match("C3", 2, "C3 body")] } });
    expect(await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "unavailable", messages: [] });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2", 2, "C2 full"), match("C3", 2, "C3 body"), match("C4", 2, "new independent")] } });
    const second = await f.reader.search({ query: "launch", cursor: first.nextCursor }, f.ctx);
    expect(second).toMatchObject({ status: "ok", complete: true });
    expect(second.messages.map(m => [m.channel, m.ts, m.searchMatch])).toEqual([["C2", ts(2), true], ["C4", ts(2), true]]);
  });
  it("keeps 160 distinct delivered channel/ts keys across four 40-message pages with no raw text/metadata in cursor", async () => {
    const f = fixture();
    const cursors = (f.reader as unknown as { searcher: { cursors: Map<string, { fingerprints: Record<string, Record<string, string>>; deliveredRoles: Record<string, string> }> } }).searcher.cursors;
    let cursor: string | undefined;
    const all = [];
    for (let page = 1; page <= 4; page++) {
      const base = page * 100;
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: Array.from({ length: 20 }, (_, n) => ({
        ...match(`CTARGET${n}`, base + 2, `PRIVATE_PRIMARY_${page}_${n}`),
        context_messages: { before: [{ ts: ts(base + 1), text: `PRIVATE_CONTEXT_${page}_${n}`, user_id: "UMETA", thread_ts: ts(0) }] },
      })) }, next_cursor: `raw-page-${page}` });
      const result = await f.reader.search({ query: "launch", ...(cursor ? { cursor } : {}) }, f.ctx);
      expect(result).toMatchObject({ status: "ok", page, complete: false }); expect(result.messages).toHaveLength(40);
      all.push(...result.messages); cursor = result.nextCursor ?? undefined;
      if (cursor) {
        const state = cursors.get(cursor)!;
        expect(Object.keys(state.fingerprints)).toHaveLength(page * 40);
        expect(Object.keys(state.deliveredRoles).sort()).toEqual(Object.keys(state.fingerprints).sort());
        expect(Object.keys(state.fingerprints).every(key => JSON.parse(key).length === 2)).toBe(true);
        expect(Object.values(state.fingerprints).every(hashes => Object.keys(hashes).length <= 2 && Object.values(hashes).every(hash => /^[a-f0-9]{64}$/.test(hash)))).toBe(true);
        for (const secret of ["PRIVATE_PRIMARY_", "PRIVATE_CONTEXT_", "UMETA", ts(0), token]) expect(JSON.stringify(state)).not.toContain(secret);
      }
    }
    expect(new Set(all.map(m => JSON.stringify([m.channel, m.ts]))).size).toBe(160); expect(all).toHaveLength(160); expect(cursor).toBeUndefined();
  });
  it.each([undefined, "C2"])("binds workspace/scoped cursor %s to scope, target, origin, requester, team, request, query, limit", async channel => {
    const f = fixture(); const input = { query: "launch", limit: 2, ...(channel ? { channel } : {}) };
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2")] }, next_cursor: "next" });
    const first = await f.reader.search(input, f.ctx); expect(first.status).toBe("ok");
    const cursor = first.nextCursor;
    for (const altered of [{ ...input, channel: "C3" }, { ...input, channel: channel ? undefined : "C2" }, { ...input, query: "other" }, { ...input, limit: 1 }]) {
      expect((await f.reader.search({ ...altered, cursor }, f.ctx)).status).toBe("invalid_target");
    }
    for (const changes of [{ userId: "UOTHER" }, { teamId: "TOTHER" }, { channel: "COTHER" }, { requestId: "another", threadTs: "1700000000.000001" }]) {
      expect((await f.reader.search({ ...input, cursor }, context(changes))).status).toBe("invalid_target");
    }
    expect(f.apiCall).toHaveBeenCalledTimes(1);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2", 3)] } });
    expect(await f.reader.search({ ...input, cursor }, f.ctx)).toMatchObject({ status: "ok", page: 2 });
  });
});

describe("explicit cross-public full thread, separate bounded membership policy", () => {
  it.each(["address", "url"])("reads explicit %s with actual target source and live continuation authorization", async mode => {
    const f = fixture(); f.members.mockResolvedValue({ ok: true, members: ["U1"] });
    const input = mode === "address" ? { channel: "C2", ts: ts(1) } : { url: `https://synthetic.slack.com/archives/C2/p${ts(2).replace(".", "")}?thread_ts=${ts(1)}&cid=C2` };
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: ts(1), text: "target root", reply_count: 1 }], response_metadata: { next_cursor: "thread-next" } });
    const first = await f.reader.read("thread", input, f.ctx);
    expect(first).toMatchObject({ status: "ok", source: { channel: "C2", threadTs: ts(1) }, complete: false });
    expect(f.replies).toHaveBeenLastCalledWith({ channel: "C2", ts: ts(1), limit: 14 });
    expect((await f.reader.read("thread", { ...input, cursor: first.nextCursor }, context({ channel: "COTHER" }))).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { channel: "C3", ts: ts(1), cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(2), cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target");
    f.members.mockImplementation(async ({ channel }) => ({ ok: true, members: channel === "C1" ? ["U1"] : [] }));
    expect((await f.reader.read("thread", { ...input, cursor: first.nextCursor }, f.ctx)).status).toBe("access_denied");
    expect(f.replies).toHaveBeenCalledTimes(1);
    f.members.mockResolvedValue({ ok: true, members: ["U1"] });
    const last = await f.reader.read("thread", { ...input, cursor: first.nextCursor }, f.ctx);
    expect(last).toMatchObject({ status: "ok", source: { channel: "C2", threadTs: ts(1) }, page: 2, complete: true, messages: [{ channel: "C2", text: "target reply" }] });
    expect(f.replies).toHaveBeenLastCalledWith({ channel: "C2", ts: ts(1), limit: 14, cursor: "thread-next" });
    expect(f.info.mock.calls.map(([args]) => args.channel)).toEqual(["C1", "C2", "C1", "C2", "C1", "C2"]);
    expect(f.history).not.toHaveBeenCalled(); expect(f.join).not.toHaveBeenCalled();
  });
  it("allows native public search for a nonmember, but denies full thread and exact attachment bridge", async () => {
    const f = fixture();
    expect((await f.reader.search({ query: "launch" }, f.ctx)).status).toBe("ok");
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("access_denied");
    expect((await f.reader.read("channel", { channel: "C2" }, f.ctx)).status).toBe("access_denied");
    await expect(readAuthorizedSlackMessage(f.client, f.ctx, { channelId: "C2", messageTs: ts(2) })).rejects.toMatchObject({ status: "access_denied" });
    expect(f.replies).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled(); expect(f.join).not.toHaveBeenCalled();
    expect(channelInput.shape.channel.description).toContain("다른 채널은 허용하지 않습니다");
    expect(threadInput.shape.channel.description).toContain("공개 채널만");
  });
  it("bounds target membership at 200 x 3 without treating bot-only members as requester authority", async () => {
    const f = fixture(); f.members.mockImplementation(async ({ channel }) => channel === "C1" ? { ok: true, members: ["U1"] } :
      { ok: true, members: ["UBOT"], response_metadata: { next_cursor: `target-${f.members.mock.calls.length}` } });
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("access_denied");
    const targetCalls = f.members.mock.calls.filter(([args]) => args.channel === "C2");
    expect(targetCalls).toHaveLength(3); expect(targetCalls.every(([args]) => (args as { limit?: number }).limit === 200)).toBe(true);
    expect(f.replies).not.toHaveBeenCalled();
  });
  it("finds requester on target membership page two and rejects repeated target cursors fail-closed", async () => {
    const f = fixture(); f.members.mockResolvedValueOnce({ ok: true, members: ["U1"] })
      .mockResolvedValueOnce({ ok: true, members: ["UBOT"], response_metadata: { next_cursor: "target-members" } } as never)
      .mockResolvedValueOnce({ ok: true, members: ["U1"] });
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("ok");
    expect(f.members).toHaveBeenLastCalledWith({ channel: "C2", limit: 200, cursor: "target-members" });
    f.members.mockImplementation(async ({ channel }) => channel === "C1" ? { ok: true, members: ["U1"] } :
      { ok: true, members: ["UBOT"], response_metadata: { next_cursor: "repeat" } });
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("access_denied");
    expect(f.replies).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "U1", Array.from({ length: 201 }, () => "U1"), ["invalid"]])("does not accept malformed target membership %j", async members => {
    const f = fixture(); f.members.mockResolvedValueOnce({ ok: true, members: ["U1"] }).mockResolvedValueOnce({ ok: true, members } as never);
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("unavailable");
    expect(f.replies).not.toHaveBeenCalled();
  });
  it.each(["not_in_channel", "missing_scope", "not_allowed_token_type"])("reports bot full-thread SDK denial %s, without join/token/history fallback", async error => {
    const f = fixture(); f.members.mockResolvedValue({ ok: true, members: ["U1"] }); f.replies.mockRejectedValueOnce({ data: { error }, token });
    const result = await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx);
    expect(result).toMatchObject({ status: error === "not_allowed_token_type" ? "unsupported" : "access_denied", messages: [], complete: false });
    expect(JSON.stringify(result)).not.toContain(token); expect(f.replies).toHaveBeenCalledTimes(1);
    expect(f.join).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled(); expect(f.apiCall).not.toHaveBeenCalled();
  });
  it.each([{ is_private: true }, { is_group: true }, { is_shared: true }, { is_ext_shared: true }, { is_org_shared: true }, { context_team_id: "TOTHER" }, { is_private: undefined }, { is_group: undefined }])("denies nonpublic/shared/foreign or ambiguous thread targets: %j", async overrides => {
    const f = fixture(); f.info.mockImplementation(async ({ channel }) => ({ ok: true, channel: { ...publicInfo(channel), ...(channel === "C2" ? overrides : {}) } }));
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("access_denied"); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([{ is_shared: true }, { is_ext_shared: true }, { is_org_shared: true }])("does not widen trusted origin shared policy: %j", async overrides => {
    const f = fixture(); f.info.mockImplementation(async ({ channel }) => ({ ok: true, channel: { ...publicInfo(channel), ...(channel === "C1" ? overrides : {}) } }));
    expect((await f.reader.search({ query: "launch" }, f.ctx)).status).toBe("access_denied");
    expect((await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.ctx)).status).toBe("access_denied");
    expect(f.info.mock.calls.every(([args]) => args.channel === "C1")).toBe(true); expect(f.apiCall).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("preserves sameworkspace exact URL host/channel/parent and strict schema authority", async () => {
    const f = fixture(); const url = `https://synthetic.slack.com/archives/C2/p${ts(2).replace(".", "")}?thread_ts=${ts(1)}&cid=C2`;
    expect((await f.reader.read("thread", { url: url.replace("synthetic", "foreign") }, f.ctx)).status).toBe("access_denied");
    for (const input of [{ url, channel: "C3" }, { url, ts: ts(2) }, { url: url.replace("cid=C2", "cid=C3") }, { channel: "C2" }, { channel: "C2", ts: ts(1), userId: "UADMIN" }]) {
      expect((await f.reader.read("thread", input, f.ctx)).status).toBe("invalid_target");
    }
    for (const channel of ["GPRIVATE", "DOTHER"]) expect((await f.reader.read("thread", { channel, ts: ts(1) }, f.ctx)).status).toBe("access_denied");
    expect(f.replies).not.toHaveBeenCalled();
  });
});
