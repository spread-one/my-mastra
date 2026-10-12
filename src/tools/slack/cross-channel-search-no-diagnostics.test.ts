import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
const logger = console;
import { SlackSearcher } from "./search.js";
import type { SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readOutput } from "./schemas.js";


const token = "SYNTHETIC_DIAGNOSTIC_SECRET";
const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const message = (n = 2) => ({ channel_id: "CTARGET", team_id: "TTEAM", message_ts: ts(n), content: "PRIVATE_PRIMARY",
  author_user_id: "UACTOR", is_author_bot: false, permalink: `https://synthetic.slack.com/archives/CTARGET/p${ts(n).replace(".", "")}` });
function fixture() {
  const context = new RequestContext(); context.set("requestId", "FORGED_REQUEST_ID");
  bindSlackReadContext(context, { userId: "UREQUESTER", teamId: "TTEAM", channel: "CORIGIN", requestId: "trusted-event", threadTs: "1700000000.000001" }, token);
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "TTEAM", url: "https://synthetic.slack.com/" });
  const info = vi.fn(async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } }));
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["UREQUESTER"] });
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [message()] } });
  const history = vi.fn(), replies = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, history, replies }, apiCall } as unknown as SlackReadClient;
  const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
  return { context, auth, info, members, apiCall, history, replies, client, searcher: new SlackSearcher(client), spy };
}
afterEach(() => vi.restoreAllMocks());
function assertNoDiagnostics(f: ReturnType<typeof fixture>) {
  // Direct search must not introduce replacement logs, including with a throwing logger.
  expect(f.spy).not.toHaveBeenCalled();
}

describe("cross-channel search guards without instrumentation (synthetic, NOT actual E2E)", () => {
  it.each([
    ["user", { user_id: "UOTHER", is_author_bot: true, thread_ts: ts(0) }, { thread_ts: ts(1) }],
    ["kind", { user_id: "UACTOR", is_author_bot: true, thread_ts: ts(0) }, { thread_ts: ts(1) }],
    ["thread", { user_id: "UACTOR", is_author_bot: false, thread_ts: ts(0) }, { thread_ts: ts(1) }],
  ])("rejects incompatible %s metadata before omitting alternate context", async (_field, contextMeta, primaryMeta) => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), ...primaryMeta }, { ...message(4), context_messages: { before: [{ ts: ts(2), text: "PRIVATE_CONTEXT PRIVATE_PRIMARY suffix", ...contextMeta }] } }] } });
    const result = await f.searcher.search({ query: "keyword" }, f.context);
    expect(result).toMatchObject({ status: "unavailable", messages: [], nextCursor: null }); expect(readOutput.safeParse(result).success).toBe(true);
    expect(result.message).toBe("Slack 결과를 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해주세요.");
    assertNoDiagnostics(f); expect(f.apiCall).toHaveBeenCalledTimes(1); expect(f.members).toHaveBeenCalledTimes(1); expect(f.info).toHaveBeenCalledTimes(2); expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it("preserves primary provenance and partial for compatible nonprefix context", async () => {
    const f = fixture(), primary = message();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [primary,
      { ...message(4), context_messages: { before: [{ ts: ts(2), text: "PRIVATE_CONTEXT PRIVATE_PRIMARY suffix", user_id: "UACTOR", is_author_bot: false }] } },
    ] } });
    const result = await f.searcher.search({ query: "keyword" }, f.context);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!).toMatchObject({ text: primary.content, textTruncated: false, searchMatch: true,
      permalink: primary.permalink, author: { userId: primary.author_user_id, kind: "participant", botId: null } });
    expect(result.messages[0]!).not.toHaveProperty("contextForTs");
    expect(readOutput.safeParse(result).success).toBe(true);
    assertNoDiagnostics(f);
  });
  it.each([
    ["primary scope", { team: "TOTHER" }], ["permalink parse", { permalink: "not a URL" }],
    ["permalink channel", { permalink: `${message().permalink}?cid=CORIGIN` }],
    ["context scope", { context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", channel: "CORIGIN" }] } }],
    ["context time", { context_messages: { before: [{ ts: ts(2), text: "PRIVATE_CONTEXT" }] } }],
    ["thread scope", { thread_ts: ts(1), context_messages: { before: [{ ts: ts(1), text: "PRIVATE_CONTEXT", thread_ts: ts(0) }] } }],
  ])("preserves %s refusal without source disclosure", async (_guard, changes) => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), ...changes }] } });
    expect(await f.searcher.search({ query: "keyword" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    assertNoDiagnostics(f);
  });
  it.each([
    [`http://synthetic.slack.com/archives/CTARGET/p${ts(2).replace(".", "")}`, false],
    [`https://evil.slack.com/archives/CTARGET/p${ts(2).replace(".", "")}`, false],
    [`${message().permalink}#private`, false],
    [`https://synthetic.slack.com/archives/COTHER/p${ts(2).replace(".", "")}`, false],
    [`https://synthetic.slack.com/archives/CTARGET/p${ts(1).replace(".", "")}`, false],
    [`${message().permalink}?cid=CTARGET&cid=CTARGET`, false],
    [`${message().permalink}?private_key=${token}`, false],
    [`${message().permalink}?cid=CORIGIN`, false],
    [`${message().permalink}?thread_ts=${ts(3)}`, false],
    [`${message().permalink}?thread_ts=${ts(0)}`, true],
  ])("refuses unsafe permalink %s without logging URL or query hints", async (permalink, withThread) => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), permalink, ...(withThread ? { thread_ts: ts(1) } : {}) }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
  });
  it("rejects large page-local same-role conflicts", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: "😀".repeat(6_001) }, { ...message(), content: "different" }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
  });
  it("retains the seed after cursor conflicts/replay and live metadata permission refusal", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await f.searcher.search({ query: "keyword" }, f.context);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "a", response_metadata: { next_cursor: "b" } });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "CORIGIN", context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } });
    f.info.mockRejectedValueOnce({ data: { error: "not_in_channel" }, message: token });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("access_denied");
    assertNoDiagnostics(f);
    expect(await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 }); assertNoDiagnostics(f);
  });
  it("rejects missing schema fields and nonpublic channel IDs without inspecting issue metadata", async () => {
    const f = fixture(); const m = message();
    delete (m as Partial<typeof m>).is_author_bot;
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [m] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), channel_id: "GPRIVATE" }] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    assertNoDiagnostics(f);
  });
  it("preserves transport/check/verification error statuses and call counts", async () => {
    const f = fixture();
    f.apiCall.mockRejectedValueOnce({ message: token, data: { error: "missing_scope" } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("access_denied");
    assertNoDiagnostics(f);
    f.apiCall.mockResolvedValueOnce({ ok: false, error: "missing_scope" });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("access_denied");
    assertNoDiagnostics(f);
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "CORIGIN", context_team_id: "TTEAM", is_channel: true, is_private: false, is_group: false } });
    f.info.mockRejectedValueOnce({ statusCode: 429, retryAfter: 37, message: token });
    expect(await f.searcher.search({ query: "keyword", channel: "CTARGET" }, f.context)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 37 });
    assertNoDiagnostics(f);
    expect(f.apiCall).toHaveBeenCalledTimes(2);
  });
  it("does not reread raw getter/proxy/toJSON on same-role rejection", async () => {
    const f = fixture(), getter = vi.fn(() => "PRIVATE_CONTEXT"), toJSON = vi.fn(() => { throw new Error(token); });
    const raw = Object.defineProperty({ ...message(), toJSON }, "content", { get: getter, enumerable: true });
    const gets: string[] = [];
    const proxy = new Proxy(raw, { get(target, key, receiver) { if (key === "content") gets.push("content"); return Reflect.get(target, key, receiver); } });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message(), proxy] } });
    expect((await f.searcher.search({ query: "keyword" }, f.context)).status).toBe("unavailable");
    expect(getter).toHaveBeenCalledTimes(1); expect(gets).toEqual(["content"]); expect(toJSON).not.toHaveBeenCalled(); assertNoDiagnostics(f);
  });
  it("cancelled continuation drains and unlocks the same seed without calling a throwing logger", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await f.searcher.search({ query: "keyword", limit: 20 }, f.context);
    let entered!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.apiCall.mockImplementationOnce(() => { entered(); return new Promise((_resolve, no) => { reject = no; }); });
    assertNoDiagnostics(f); f.spy.mockImplementation(() => { throw new Error(token); });
    const controller = new AbortController();
    bindSlackReadContext(f.context, { userId: "UREQUESTER", teamId: "TTEAM", channel: "CORIGIN", requestId: "trusted-event", threadTs: "1700000000.000001" }, token, controller.signal);
    const work = f.searcher.search({ query: "keyword", limit: 20, cursor: first.nextCursor! }, f.context);
    await ready; controller.abort(); reject(new Error(token));
    expect(await work).toMatchObject({ status: "unavailable" });
    bindSlackReadContext(f.context, { userId: "UREQUESTER", teamId: "TTEAM", channel: "CORIGIN", requestId: "trusted-event", threadTs: "1700000000.000001" }, token);
    assertNoDiagnostics(f);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await f.searcher.search({ query: "keyword", limit: 20, cursor: first.nextCursor! }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(3); assertNoDiagnostics(f);
  });
  it("keeps seed immutable, bounded and text-free through rejection/unlock/retry", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] }, next_cursor: "PRIVATE_CURSOR" });
    const first = await f.searcher.search({ query: "keyword" }, f.context);
    expect(first).toMatchObject({ status: "ok" }); assertNoDiagnostics(f);
    const cursors = (f.searcher as unknown as { cursors: Map<string, object> }).cursors;
    const seed = JSON.stringify(cursors.get(first.nextCursor!));
    expect(Object.keys(cursors.get(first.nextCursor!)!).sort()).toEqual(["binding", "cursor", "deliveredRoles", "expires", "fingerprints", "lossy", "page", "used"]);
    for (const text of [token, "PRIVATE_PRIMARY", "PRIVATE_CONTEXT"]) expect(seed).not.toContain(text);
    f.spy.mockImplementation(() => { throw new Error(token); });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...message(), content: "PRIVATE_CONTEXT" }] } });
    expect((await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).status).toBe("unavailable");
    expect(JSON.stringify(cursors.get(first.nextCursor!))).toBe(seed);
    assertNoDiagnostics(f);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [message()] } });
    expect(await f.searcher.search({ query: "keyword", cursor: first.nextCursor }, f.context)).toMatchObject({ status: "ok", page: 2 });
    expect(f.apiCall).toHaveBeenCalledTimes(3); expect(cursors.has(first.nextCursor!)).toBe(false); assertNoDiagnostics(f);
  });
});
