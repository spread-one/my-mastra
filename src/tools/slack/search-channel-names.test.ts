import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
const logger = console;
import { SlackReader, type SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readOutput } from "./schemas.js";

const token = "SYNTHETIC_CHANNEL_NAME_ACTION";
const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const publicInfo = (id: string) => ({ id, context_team_id: "T1", is_channel: true, is_private: false, is_group: false });
const match = (channel: string, n = 2, content = "primary") => ({ channel_id: channel, team_id: "T1", message_ts: ts(n),
  content, is_author_bot: false, author_user_id: "U2", permalink: `https://synthetic.slack.com/archives/${channel}/p${ts(n).replace(".", "")}` });
function fixture(metadata: (id: string) => object = id => ({ ...publicInfo(id), name: `verified-${id}` })) {
  const context = new RequestContext();
  bindSlackReadContext(context, { teamId: "T1", userId: "U1", channel: "C1", requestId: "name-event", threadTs: "1700000000.000001" }, token);
  const auth = vi.fn().mockResolvedValue({ ok: true, team_id: "T1", bot_id: "B1", url: "https://synthetic.slack.com/" });
  const info = vi.fn(async ({ channel }: { channel: string }) => ({ ok: true, channel: metadata(channel) }));
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"] });
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [match("C2")] } });
  const history = vi.fn(), replies = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, history, replies }, apiCall } as unknown as SlackReadClient;
  return { reader: new SlackReader(client), context, info, auth, members, apiCall, history, replies };
}
afterEach(() => vi.restoreAllMocks());

describe("live verified display-only search channel names (synthetic)", () => {
  it("uses each actual primary/context channel with same-ts independent identities and one verification per page", async () => {
    const f = fixture();
    const forbidden = vi.fn(() => { throw new Error("must not traverse result name aliases"); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [
      Object.defineProperty({ ...match("C2"), channel_name: "unverified-alias", context_messages: { before: [{ ts: ts(1), text: "context two" }] } }, "name", { get: forbidden }),
      { ...match("C3"), context_messages: { before: [{ ts: ts(1), text: "context three", channel_id: "C3" }] } }, match("C2"),
    ] } });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", searchScope: "workspace_public", complete: true });
    expect(result).not.toHaveProperty("source"); expect(readOutput.safeParse(result).success).toBe(true);
    expect(result.messages.map(m => [m.channel, m.channelName, m.ts, m.searchMatch])).toEqual([
      ["C2", "verified-C2", ts(1), false], ["C3", "verified-C3", ts(1), false],
      ["C2", "verified-C2", ts(2), true], ["C3", "verified-C3", ts(2), true],
    ]);
    for (const m of result.messages.filter(m => m.searchMatch)) expect(m.permalink).toBe(match(m.channel).permalink);
    expect(forbidden).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("unverified-alias");
    expect(f.info.mock.calls.map(([arg]) => arg.channel)).toEqual(["C1", "C2", "C3"]);
    expect(f.auth).toHaveBeenCalledTimes(1); expect(f.apiCall).toHaveBeenCalledTimes(1);
    expect(f.members).toHaveBeenCalledExactlyOnceWith({ channel: "C1", limit: 200 });
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("keeps the 20-channel metadata budget with names and never stores them in continuation state", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: Array.from({ length: 20 }, (_, n) => match(`CTARGET${n}`)) }, next_cursor: "next" });
    const result = await f.reader.search({ query: "launch" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false }); expect(result.messages).toHaveLength(20);
    expect(result.messages.every(m => m.channelName === `verified-${m.channel}`)).toBe(true);
    expect(f.info).toHaveBeenCalledTimes(21); // 20 result channels plus the unchanged live origin check.
    const state = (f.reader as unknown as { searcher: { cursors: Map<string, unknown> } }).searcher.cursors.get(result.nextCursor!);
    expect(JSON.stringify(state)).not.toContain("verified-"); expect(JSON.stringify(state)).not.toContain("channelName");
    expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.members).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("decorates the scoped source even for an empty page (%s) without extra calls", async empty => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: empty ? [] : [match("C2")] } });
    const result = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
    expect(result).toMatchObject({ status: "ok", searchScope: "channel", source: { channel: "C2", channelName: "verified-C2" }, complete: true });
    expect(f.info.mock.calls.map(([arg]) => arg.channel)).toEqual(["C1", "C2"]);
    expect(f.apiCall).toHaveBeenCalledExactlyOnceWith("assistant.search.context", expect.objectContaining({ query: 'in:<#C2> "launch"' }));
  });
  it("revalidates renamed metadata on continuation without including names in binding, roles or hashes", async () => {
    let name = "old-display-name";
    const f = fixture(id => ({ ...publicInfo(id), name }));
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match("C2", 4), context_messages: { before: [{ ts: ts(2), text: "primary" }] } }] }, next_cursor: "next" });
    const first = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
    expect(first).toMatchObject({ status: "ok", source: { channelName: name }, messages: [{ channelName: name }, { channelName: name }] });
    const cursors = (f.reader as unknown as { searcher: { cursors: Map<string, unknown> } }).searcher.cursors;
    const seed = JSON.stringify(cursors.get(first.nextCursor!));
    expect(seed).not.toContain(name); expect(seed).not.toContain("channelName");
    name = "renamed-display-name";
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match("C2")] } });
    const second = await f.reader.search({ query: "launch", channel: "C2", cursor: first.nextCursor }, f.context);
    expect(second).toMatchObject({ status: "ok", page: 2, complete: true, source: { channelName: name }, messages: [{ channel: "C2", channelName: name, ts: ts(2), searchMatch: true, text: "primary" }] });
    expect(f.info.mock.calls.map(([arg]) => arg.channel)).toEqual(["C1", "C2", "C1", "C2"]);
    expect(f.apiCall).toHaveBeenCalledTimes(2); expect(f.members).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, 1, true, "", " leading", "trailing ", "\tname", "name\n", "con\u0000trol", "del\u007f", "c1\u0085", "a".repeat(81), "😀".repeat(41)])("omits absent/invalid names without rejecting search: %j", async name => {
    const f = fixture(id => ({ ...publicInfo(id), name }));
    const result = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: true, source: { channel: "C2" }, messages: [{ channel: "C2", text: "primary" }] });
    expect(result.source).not.toHaveProperty("channelName"); expect(result.messages[0]!).not.toHaveProperty("channelName");
    expect(f.info.mock.calls.map(([arg]) => arg.channel)).toEqual(["C1", "C2"]);
    expect(readOutput.safeParse(result).success).toBe(true);
  });
  it.each(["a".repeat(80), "😀".repeat(40), "채널-이름"])("accepts bounded primitive names without replacing IDs: %s", async name => {
    const f = fixture(id => ({ ...publicInfo(id), name }));
    expect(await f.reader.search({ query: "launch", channel: "C2" }, f.context)).toMatchObject({ status: "ok", source: { channel: "C2", channelName: name }, messages: [{ channel: "C2", channelName: name }] });
  });
  it.each(["getter", "inherited", "boxed", "proxy-name", "proxy-channel", "revoked-name"])("does not execute hostile optional metadata (%s) or add Proxy traps", async mode => {
    const forbidden = vi.fn(() => { throw new Error("optional display metadata must not execute"); });
    const rawAuthorityReads: PropertyKey[] = [];
    const f = fixture(id => {
      const channel = publicInfo(id);
      if (mode === "getter") return Object.defineProperty(channel, "name", { get: forbidden });
      if (mode === "inherited") return Object.assign(Object.create({ name: "inherited-not-own" }), channel);
      if (mode === "boxed") return { ...channel, name: Object.assign(new String("boxed"), { toString: forbidden, toJSON: forbidden, [Symbol.toPrimitive]: forbidden }) };
      if (mode === "proxy-channel") return new Proxy({ ...channel, name: "do-not-read" }, {
        get(target, key, receiver) { rawAuthorityReads.push(key); if (key === "name") return forbidden(); return Reflect.get(target, key, receiver); },
        getOwnPropertyDescriptor: forbidden, ownKeys: forbidden,
      });
      const proxied = Proxy.revocable({}, { get: forbidden, getOwnPropertyDescriptor: forbidden, ownKeys: forbidden });
      if (mode === "revoked-name") proxied.revoke();
      return { ...channel, name: proxied.proxy, toJSON: forbidden };
    });
    const result = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: true });
    expect(result.source).not.toHaveProperty("channelName"); expect(result.messages[0]!).not.toHaveProperty("channelName");
    expect(forbidden).not.toHaveBeenCalled();
    if (mode === "proxy-channel") {
      // Original origin/target raw guards are unchanged; no optional property/descriptor reads.
      expect(rawAuthorityReads).not.toContain("name");
      expect(rawAuthorityReads.slice(-10)).toEqual(["id", "context_team_id", "is_channel", "is_private", "is_group", "is_im", "is_mpim", "is_ext_shared", "is_org_shared", "is_shared"]);
    }
  });
  it("preserves full-thread membership denial with a verified name and does not add thread channelName support", async () => {
    const f = fixture();
    f.members.mockImplementation(async ({ channel }: { channel: string }) => ({ ok: true, members: channel === "C1" ? ["U1"] : [] }));
    expect(await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.context)).toMatchObject({ status: "access_denied", messages: [] });
    expect(f.replies).not.toHaveBeenCalled();
    f.members.mockResolvedValue({ ok: true, members: ["U1"] });
    f.replies.mockResolvedValue({ ok: true, messages: [{ ts: ts(1), text: "root" }] });
    const result = await f.reader.read("thread", { channel: "C2", ts: ts(1) }, f.context);
    expect(result).toMatchObject({ status: "ok", source: { channel: "C2", threadTs: ts(1) } });
    expect(result.source).not.toHaveProperty("channelName"); expect(result.messages[0]!).not.toHaveProperty("channelName");
  });
  it("does not inspect even an own name until raw authority succeeds", async () => {
    const forbidden = vi.fn(() => { throw new Error("denied name must not be read"); });
    const f = fixture(id => Object.defineProperty({ ...publicInfo(id), ...(id === "C2" ? { is_private: true } : {}) }, "name", { get: forbidden }));
    expect(await f.reader.search({ query: "launch", channel: "C2" }, f.context)).toMatchObject({ status: "access_denied", messages: [], nextCursor: null });
    expect(f.apiCall).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  });
  it("suppresses names containing the action token in both messages and scoped source without diagnostics", async () => {
    const logs = ["info", "debug", "warn", "error"] as const;
    const spies = logs.map(method => vi.spyOn(logger, method).mockImplementation(() => {}));
    const f = fixture(id => ({ ...publicInfo(id), name: `prefix-${token}-suffix` }));
    const result = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: true });
    expect(result.source).not.toHaveProperty("channelName"); expect(result.messages[0]!).not.toHaveProperty("channelName");
    expect(JSON.stringify(result)).not.toContain(token); expect(spies.flatMap(spy => spy.mock.calls)).toEqual([]);
  });
  it("accounts for channelName JSON escaping and UTF-8 in the existing 96KB envelope and 24KB body budgets", async () => {
    const name = '한"\\'.repeat(26); // 78 code units; escaping and UTF-8 both matter.
    const run = async (withNames: boolean) => {
      const f = fixture(id => ({ ...publicInfo(id), ...(withNames ? { name } : {}) }));
      f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: Array.from({ length: 20 }, (_, n) => ({
        ...match("C2", n * 2 + 2, "x".repeat(24_000)), context_messages: { before: [{ ts: ts(n * 2 + 1), text: "x".repeat(24_000) }] },
      })) } });
      const output = await f.reader.search({ query: "launch", channel: "C2" }, f.context);
      expect(output).toMatchObject({ status: "ok", complete: false, truncated: true });
      expect(output.messages).toHaveLength(40); expect(output.messages.filter(m => m.searchMatch)).toHaveLength(20);
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(96_000);
      for (const m of output.messages) expect(Buffer.byteLength(JSON.stringify(m.text)) - 2).toBeLessThanOrEqual(24_000);
      expect(f.info.mock.calls.map(([arg]) => arg.channel)).toEqual(["C1", "C2"]);
      expect(readOutput.safeParse(output).success).toBe(true);
      return output;
    };
    const unnamed = await run(false), named = await run(true);
    expect(named.source?.channelName).toBe(name); expect(named.messages.every(m => m.channelName === name)).toBe(true);
    const textBytes = (output: typeof named) => output.messages.reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m.text)) - 2, 0);
    const addedMetadataBytes = 41 * Buffer.byteLength(`,"channelName":${JSON.stringify(name)}`);
    expect(textBytes(unnamed) - textBytes(named)).toBe(addedMetadataBytes);
  });
});
