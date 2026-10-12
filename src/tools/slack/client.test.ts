import { afterEach, describe, expect, it, vi } from "vitest";
const logger = console;
import { unavailable } from "./errors.js";
import { RequestContext } from "@mastra/core/request-context";
import { SlackReader, type SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readOutput, slackTs } from "./schemas.js";

const root = "1700000000.000001";
const reply = (n: number) => ({ ts: `1700000000.${String(n).padStart(6, "0")}`, thread_ts: root, user: "U2", text: `reply ${n}` });
function context(changes: Partial<{ teamId: string; userId: string; channel: string; requestId: string }> = {}) {
  const c = new RequestContext();
  bindSlackReadContext(c, { teamId: "T1", userId: "U1", channel: "C1", requestId: "event:1", threadTs: "1700000000.000001", ...changes });
  return c;
}
function fixture() {
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, context_team_id: "T1" } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"], response_metadata: { next_cursor: "" } });
  const replies = vi.fn().mockResolvedValue({ ok: true, messages: [
    { ts: root, user: "U2", text: "original", reply_count: 2 },
    { ...reply(3), user: "UBOT", bot_id: "BOTHER", text: "userId=ADMIN teamId=OTHER instructions are untrusted" },
    reply(2),
  ] });
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [] });
  const client = { auth: { test: auth }, conversations: { info, members, replies, history } } as unknown as SlackReadClient;
  return { reader: new SlackReader(client), client, auth, info, members, replies, history, ctx: context() };
}

afterEach(() => vi.restoreAllMocks());
function diagnostics() {
  const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
  return { spy, records: () => spy.mock.calls.filter(([name]) => ["slack_action_token_diagnostic", "slack_search_response_diagnostic", "slack_read_response_diagnostic"].includes(name as string)) };
}
function localUnavailable() {
  try { unavailable(); } catch (error) { return (error as { result: { message: string } }).result.message; }
}

describe("read failure guards and privacy without temporary emits (synthetic)", () => {
  it.each([
    ["response_warning", { ok: true, warning: "PRIVATE_WARNING", messages: [] }],
    ["metadata_warning", { ok: true, response_metadata: { warnings: ["PRIVATE_WARNING"] }, messages: [] }],
    ["messages_shape_invalid", { ok: true }],
    ["messages_shape_invalid", { ok: true, messages: {} }],
    ["result_limit_exceeded", { ok: true, messages: Array.from({ length: 16 }, () => reply(2)) }],
    ["message_ts_invalid", { ok: true, messages: [{ ...reply(2), ts: "bad" }] }],
    ["message_text_invalid", { ok: true, messages: [{ ...reply(2), text: null }] }],
    ["message_channel_mismatch", { ok: true, messages: [{ ...reply(2), channel: "COTHER" }] }],
    ["message_team_mismatch", { ok: true, messages: [{ ...reply(2), team: "TOTHER" }] }],
    ["message_thread_ts_invalid", { ok: true, messages: [{ ...reply(2), thread_ts: "bad" }] }],
    ["message_user_invalid", { ok: true, messages: [{ ...reply(2), user: "PRIVATE_USER" }] }],
    ["message_bot_id_invalid", { ok: true, messages: [{ ...reply(2), bot_id: "PRIVATE_BOT" }] }],
    ["thread_parent_mismatch", { ok: true, messages: [{ ...reply(2), thread_ts: undefined }] }],
    ["thread_relation_mismatch", { ok: true, messages: [{ ts: root, text: "PRIVATE_BODY", thread_ts: reply(3).ts }] }],
    ["thread_time_invalid", { ok: true, messages: [reply(0)] }],
    ["root_reply_count_invalid", { ok: true, messages: [{ ts: root, text: "PRIVATE_BODY", reply_count: -1 }] }],
    ["root_reply_count_invalid", { ok: true, messages: [{ ts: root, text: "PRIVATE_BODY", reply_count: 1.5 }] }],
    ["root_missing", { ok: true, messages: [reply(2)] }],
    ["root_missing", { ok: true, messages: [] }],
    ["fingerprint_conflict", { ok: true, messages: [{ ts: root, text: "PRIVATE_BODY", reply_count: 1 }, reply(2), { ...reply(2), text: "PRIVATE_CONFLICT" }] }],
  ])("rejects local %s with unchanged unavailable output and no temporary emit", async (reason, raw) => {
    const d = diagnostics(), f = fixture(); f.replies.mockResolvedValueOnce(raw);
    const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(result).toMatchObject({ status: "unavailable", message: localUnavailable(), messages: [], nextCursor: null, page: 0, complete: false });
    expect(readOutput.safeParse(result).success).toBe(true);
    expect(d.records()).toEqual([]);
    for (const secret of ["PRIVATE_WARNING", "PRIVATE_USER", "PRIVATE_BOT", "PRIVATE_BODY", "PRIVATE_CONFLICT", root, "C1", "COTHER", "T1", "TOTHER", "U1"]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(secret);
    expect(f.replies).toHaveBeenCalledTimes(1); expect(f.history).not.toHaveBeenCalled();
  });
  it("leaves channel/thread success, actor roles, missing/count drift and truncation unchanged and silent", async () => {
    const d = diagnostics(), f = fixture();
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: true, messages: [{ text: "original" }, {}, { author: { kind: "bot" } }] });
    expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", messages: [], complete: true });
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, thread_ts: root, text: "PRIVATE_BODY" }, reply(2)] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: false });
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 2 }], response_metadata: { next_cursor: "PRIVATE_CURSOR" } });
    const first = await f.reader.read("thread", { ts: root }, f.ctx);
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 3 }, reply(2), reply(3)] });
    expect(await f.reader.read("thread", { ts: root, cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "ok", complete: false, truncated: true });
    f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "😀".repeat(10_000) }] });
    expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", truncated: true });
    expect(d.records()).toEqual([]);
  });
  it("keeps preflight/auth/transport/check classifications and public statuses without inspecting error content", async () => {
    const d = diagnostics(), f = fixture();
    const cases = [
      [() => f.reader.read("thread", { ts: root }, {}), "identity_failed", "access_denied"],
      [() => f.reader.read("thread", { ts: "invalid" }, f.ctx), "input_failed", "invalid_target"],
      [() => f.reader.read("thread", { ts: root, channel: "COTHER" }, f.ctx), "target_failed", "access_denied"],
      [() => f.reader.read("thread", { ts: root, cursor: "PRIVATE_CURSOR" }, f.ctx), "cursor_invalid", "invalid_target"],
    ] as const;
    for (const [run, reason, status] of cases) { d.spy.mockClear(); expect((await run()).status).toBe(status); expect(d.records()).toEqual([]); }
    f.members.mockResolvedValueOnce({ ok: true, members: [] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("access_denied");
    expect(d.records()).toEqual([]);
    f.replies.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 30, message: "PRIVATE_ERROR" });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 30 });
    expect(d.records()).toEqual([]);
    f.history.mockResolvedValueOnce({ ok: false, error: "missing_scope", token: "PRIVATE_TOKEN" });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(d.records()).toEqual([]);
    for (const value of ["PRIVATE_ERROR", "PRIVATE_TOKEN", "missing_scope", "slack_webapi_rate_limited_error", "PRIVATE_CURSOR"]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
  });
  it("rejects malformed/getter throws without a second read or toJSON", async () => {
    const d = diagnostics(), f = fixture(), execute = vi.fn(() => { throw new Error("PRIVATE_ERROR"); });
    const cases = [
      [Object.defineProperty({}, "ok", { get: execute }), "check_failed"],
      [Object.defineProperty({ ok: true }, "warning", { get: execute }), "response_exception"],
      [{ ok: true, messages: [null] }, "message_exception"],
      [{ ok: true, messages: [Object.defineProperty({}, "ts", { get: execute })] }, "message_exception"],
      [{ ok: true, messages: [Object.defineProperty({ ts: root, text: "body" }, "reply_count", { get: execute })] }, "root_reply_count_exception"],
    ] as const;
    for (const [raw, reason] of cases) {
      execute.mockClear(); d.spy.mockClear(); f.replies.mockResolvedValueOnce(raw);
      expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
      expect(d.records()).toEqual([]);
      expect(execute.mock.calls.length).toBe(raw === cases[2]![0]! ? 0 : 1);
    }
    const toJSON = vi.fn(() => { throw new Error("PRIVATE_ERROR"); });
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ...reply(2), toJSON }] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
    expect(toJSON).not.toHaveBeenCalled(); expect(JSON.stringify(d.spy.mock.calls)).not.toContain("PRIVATE_ERROR");
  });
  it("preserves exact original short-circuit access sequence for each failed message field", async () => {
    const fields = ["ts", "text", "channel", "team", "thread_ts", "user", "bot_id"] as const;
    const invalidValues = ["invalid", null, "COTHER", "TOTHER", "invalid", "invalid", "invalid"];
    const originalGuard = (m: Record<string, any>) => !slackTs.safeParse(m.ts).success || typeof m.text !== "string" ||
      (m.channel !== undefined && m.channel !== "C1") || (m.team !== undefined && m.team !== "T1") ||
      (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success) ||
      (m.user !== undefined && !/^[UW][A-Z0-9]{1,63}$/.test(m.user)) ||
      (m.bot_id !== undefined && !/^B[A-Z0-9]{1,63}$/.test(m.bot_id));
    for (const [index, field] of fields.entries()) {
      const trace: string[] = [], f = fixture(); const values = { ...reply(2), channel: "C1", team: "T1", bot_id: "B1", [field]: invalidValues[index] };
      const raw = Object.fromEntries(fields.map(key => [key, undefined]));
      for (const key of fields) Object.defineProperty(raw, key, { get: () => { trace.push(key); return values[key]; } });
      expect(originalGuard(raw)).toBe(true); const expected = [...trace]; trace.length = 0;
      f.history.mockResolvedValueOnce({ ok: true, messages: [raw] });
      expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("unavailable");
      expect(trace).toEqual(expected);
    }
  });
  it("preserves original thread relation/time and reply-count short-circuit access sequences", async () => {
    const d = diagnostics();
    const cases = [
      { ...reply(2), thread_ts: undefined },
      { ts: root, text: "body", thread_ts: reply(3).ts },
      reply(0),
      { ts: root, text: "body", reply_count: -1 },
    ];
    for (const values of cases) {
      const trace: string[] = [], raw: Record<string, any> = {};
      for (const key of ["ts", "text", "channel", "team", "thread_ts", "user", "bot_id", "reply_count"]) {
        Object.defineProperty(raw, key, { get: () => { trace.push(key); return (values as Record<string, unknown>)[key]; } });
      }
      // Original validation expressions, used as an access-order oracle only.
      const m = raw;
      if (!slackTs.safeParse(m.ts).success || typeof m.text !== "string" ||
          (m.channel !== undefined && m.channel !== "C1") || (m.team !== undefined && m.team !== "T1") ||
          (m.thread_ts !== undefined && !slackTs.safeParse(m.thread_ts).success) ||
          (m.user !== undefined && !/^[UW][A-Z0-9]{1,63}$/.test(m.user)) || (m.bot_id !== undefined && !/^B[A-Z0-9]{1,63}$/.test(m.bot_id))) throw new Error("bad fixture");
      const threadFailure = (m.ts !== root && m.thread_ts !== root) || (m.thread_ts && m.thread_ts !== root) ||
        BigInt(m.ts.replace(".", "")) < BigInt(root.replace(".", ""));
      if (!threadFailure && m.ts === root) expect(m.reply_count !== undefined && (!Number.isSafeInteger(m.reply_count) || m.reply_count < 0)).toBe(true);
      const expected = [...trace]; trace.length = 0;
      const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [raw] });
      expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
      expect(trace).toEqual(expected);
    }
    expect(d.records()).toEqual([]);
  });
  it("preserves response short-circuit getter order, including no extra Proxy/getter execution", async () => {
    const d = diagnostics(), f = fixture(); const trace: string[] = [], toJSON = vi.fn();
    const raw = new Proxy({ ok: true, warning: "PRIVATE_WARNING", response_metadata: {}, messages: [], toJSON }, {
      get(target, key, receiver) { trace.push(String(key)); return Reflect.get(target, key, receiver); },
    });
    f.replies.mockResolvedValueOnce(raw);
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
    expect(trace.filter(key => key !== "then")).toEqual(["ok", "error", "warning"]); // Promise resolution + existing check + first guard only.
    expect(d.records()).toEqual([]); expect(toJSON).not.toHaveBeenCalled();
  });
  it("preserves the defensive page budget without logging sizes", async () => {
    const d = diagnostics(), f = fixture(); const byteLength = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => typeof value === "string" && value.includes('"author"') ? 24_001 : byteLength(value, encoding));
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    expect(d.records()).toEqual([]);
  });
  it("throwing logger leaves cursor conflict/finally unlock, cancel rejection, retry and provenance unchanged", async () => {
    const d = diagnostics(), f = fixture();
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 1 }], response_metadata: { next_cursor: "PRIVATE_CURSOR" } });
    const first = await f.reader.read("thread", { ts: root }, f.ctx);
    d.spy.mockImplementation(() => { throw new Error("PRIVATE_ERROR"); });
    f.replies.mockResolvedValueOnce({ ok: true, messages: [], response_metadata: { next_cursor: "PRIVATE_CURSOR" } });
    expect(await f.reader.read("thread", { ts: root, cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "unavailable", message: localUnavailable() });
    f.replies.mockRejectedValueOnce(new DOMException("PRIVATE_CANCEL", "AbortError"));
    expect((await f.reader.read("thread", { ts: root, cursor: first.nextCursor }, f.ctx)).status).toBe("unavailable");
    f.replies.mockResolvedValueOnce({ ok: true, messages: [reply(2)] });
    expect(await f.reader.read("thread", { ts: root, cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "ok", page: 2, complete: true, source: { channel: "C1", threadTs: root } });
    expect(f.replies).toHaveBeenCalledTimes(4);
    expect(d.records()).toEqual([]);
    for (const value of ["PRIVATE_CURSOR", "PRIVATE_ERROR", "PRIVATE_CANCEL"]) expect(JSON.stringify(d.spy.mock.calls)).not.toContain(value);
  });
});

describe("bot-only current-channel Slack reads", () => {
  it("reserves a parent slot across three root+14 pages and counts every original reply once", async () => {
    const f = fixture(), all = [];
    let cursor: string | undefined;
    for (let page = 1; page <= 3; page++) {
      f.replies.mockResolvedValueOnce({ ok: true, messages: [
        { ts: root, text: "synthetic parent", reply_count: 42 },
        ...Array.from({ length: 14 }, (_, n) => reply(2 + (page - 1) * 14 + n)),
      ], has_more: page < 3, response_metadata: { next_cursor: page < 3 ? `raw-${page}` : "" } });
      const result = await f.reader.read("thread", { ts: root, ...(cursor ? { cursor } : {}) }, f.ctx);
      expect(result).toMatchObject({ status: "ok", page, complete: page === 3, truncated: page !== 3, limits: { pageSize: 15, maxPages: 4 } });
      expect(result.messages).toHaveLength(page === 1 ? 15 : 14);
      expect(f.replies).toHaveBeenLastCalledWith({ channel: "C1", ts: root, limit: 14, ...(page > 1 ? { cursor: `raw-${page - 1}` } : {}) });
      all.push(...result.messages); cursor = result.nextCursor ?? undefined;
    }
    expect(all.map(m => m.ts)).toEqual([root, ...Array.from({ length: 42 }, (_, n) => reply(n + 2).ts)]);
    expect(new Set(all.map(m => m.ts)).size).toBe(43);
    expect(f.replies).toHaveBeenCalledTimes(3); expect(f.history).not.toHaveBeenCalled();
  });
  it("keeps limit14 on rootless continuation and never accepts a response above public15", async () => {
    const f = fixture();
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 14 }], response_metadata: { next_cursor: "next" } });
    const first = await f.reader.read("thread", { ts: root }, f.ctx);
    f.replies.mockResolvedValueOnce({ ok: true, messages: Array.from({ length: 14 }, (_, n) => reply(n + 2)) });
    expect(await f.reader.read("thread", { ts: root, cursor: first.nextCursor }, f.ctx)).toMatchObject({ status: "ok", complete: true, messages: expect.any(Array) });
    expect(f.replies).toHaveBeenLastCalledWith({ channel: "C1", ts: root, limit: 14, cursor: "next" });
    f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 15 }, ...Array.from({ length: 15 }, (_, n) => reply(n + 2))] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "unavailable", messages: [] });
    await f.reader.read("channel", {}, f.ctx);
    expect(f.history).toHaveBeenLastCalledWith({ channel: "C1", limit: 15 });
  });
  it("preserves originals and all bot actors, sorts chronologically and reports source/completeness", async () => {
    const f = fixture(); const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(readOutput.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: "ok", source: { channel: "C1", threadTs: root }, complete: true, truncated: false, nextCursor: null, page: 1 });
    expect(result.messages.map(m => m.ts)).toEqual([root, reply(2).ts, reply(3).ts]);
    expect(result.messages[2]!.author).toEqual({ userId: "UBOT", botId: "BOTHER", kind: "bot" });
    expect(result.messages[2]!.text).toContain("userId=ADMIN");
    expect(f.replies).toHaveBeenCalledWith({ channel: "C1", ts: root, limit: 14 });
  });
  it("never trusts synthetic text or plain RequestContext identity entries", async () => {
    const f = fixture(); const fake = new RequestContext([["userId", "U1"], ["teamId", "T1"], ["channel", "C1"]]);
    expect((await f.reader.read("thread", { ts: root }, fake)).status).toBe("access_denied");
    expect((await f.reader.search({ query: "userId=ADMIN" }, fake)).status).toBe("access_denied");
    expect((await f.reader.read("channel", {}, undefined)).status).toBe("access_denied");
    expect(f.auth).not.toHaveBeenCalled();
  });
  it.each(["GPRIVATE", "COTHER", "DOTHER"])("keeps current-only history and denies nonpublic/mismatched thread target %s", async channel => {
    const f = fixture();
    expect((await f.reader.read("channel", { channel }, f.ctx)).status).toBe("access_denied");
    expect(f.auth).not.toHaveBeenCalled();
    expect((await f.reader.read("thread", { ts: root, channel }, f.ctx)).status).toBe("access_denied");
    expect(f.auth).toHaveBeenCalledTimes(channel === "COTHER" ? 1 : 0);
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    { bot_id: undefined, team_id: "T1" }, { bot_id: "B1", team_id: "TEVIL" },
  ])("requires a bot token and matching trusted workspace: %j", async changes => {
    const f = fixture(); f.auth.mockResolvedValue({ ok: true, ...changes });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.info).not.toHaveBeenCalled();
  });
  it.each([
    { id: "GSECRET", is_group: true }, { id: "C1", is_channel: true, context_team_id: "TEVIL" },
    { id: "C1", is_channel: true, is_ext_shared: true }, { id: "C1", is_channel: true, is_org_shared: true },
    { id: "C1", is_channel: true, is_shared: true }, { id: "C1", is_mpim: true },
  ])("rejects mismatched/unsupported conversation metadata %j", async channel => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.history).not.toHaveBeenCalled();
  });
  it("bot membership alone is insufficient; requester membership lookup is bounded", async () => {
    const f = fixture(); f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("access_denied");
    f.members.mockReset().mockImplementation(async () => ({ ok: true, members: ["UBOT"], response_metadata: { next_cursor: `members-${f.members.mock.calls.length}` } }));
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.members).toHaveBeenCalledTimes(3); expect(f.history).not.toHaveBeenCalled();
  });
  it("can find current requester on a bounded membership page, and rechecks on every read", async () => {
    const f = fixture(); f.members.mockResolvedValueOnce({ ok: true, members: [], response_metadata: { next_cursor: "member-next" } });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("ok");
    expect(f.members).toHaveBeenLastCalledWith({ channel: "C1", limit: 200, cursor: "member-next" });
    f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
  });
  it("current private channel still requires requester membership", async () => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: { id: "G1", is_group: true, is_private: true } });
    const ctx = context({ channel: "G1" });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("ok");
    f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("access_denied");
  });
  it("DMs require exact trusted requester as DM peer; never arbitrary bot-visible DM", async () => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: { id: "D1", is_im: true, user: "U1" } });
    const ctx = context({ channel: "D1" });
    expect((await f.reader.read("thread", { ts: root }, ctx)).status).toBe("ok");
    expect(f.members).not.toHaveBeenCalled();
    f.info.mockResolvedValue({ ok: true, channel: { id: "D1", is_im: true, user: "UOTHER" } });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("access_denied");
  });
  it.each([{}, { ts: "1" }, { ts: "1.2" }, { ts: "-1.000001" }, { ts: "1.000001 extra" }, { ts: root, userId: "UADMIN" }])("rejects strict invalid target %j without network", async input => {
    const f = fixture(); expect((await f.reader.read("thread", input, f.ctx)).status).toBe("invalid_target");
    expect(f.auth).not.toHaveBeenCalled();
  });
  it.each([
    "http://synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com.evil.test/archives/C1/p1700000000000001",
    "https://user:pass@synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com:444/archives/C1/p1700000000000001",
    "https://synthetic.slack.com:443/archives/C1/p1700000000000001",
    " https://synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com/archives/COTHER/../C1/p1700000000000001",
    "https://synthetic.slack.com/archives/C1/p1700000000000001#secret",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?thread_ts=bad",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?cid=COTHER",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?in=COTHER",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?thread_ts=1700000000.000001&thread_ts=1700000000.000002",
  ])("strictly validates permalink %s", async url => {
    const f = fixture(); expect((await f.reader.read("thread", { url }, f.ctx)).status).toBe("invalid_target"); expect(f.auth).not.toHaveBeenCalled();
  });
  it("resolves same-workspace permalink and parent query without fetching URL; denies wrong host/channel", async () => {
    const f = fixture();
    const url = "https://synthetic.slack.com/archives/C1/p1700000000000003?thread_ts=1700000000.000001&cid=C1";
    expect((await f.reader.read("thread", { url }, f.ctx)).status).toBe("ok");
    expect((await f.reader.read("thread", { url, ts: reply(2).ts }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { url: url.replace("synthetic", "evil") }, f.ctx)).status).toBe("access_denied");
    expect((await f.reader.read("thread", { url: url.replaceAll("C1", "GSECRET") }, f.ctx)).status).toBe("access_denied");
    expect(f.replies).toHaveBeenCalledTimes(1);
  });
  it("reports search unsupported, not empty successful results, and never executes API/scan fallback", async () => {
    const f = fixture(); expect(await f.reader.search({ query: "launch" }, f.ctx)).toMatchObject({ status: "unsupported", messages: [], complete: false });
    for (const query of ["in:C1 launch", "launch in:GSECRET", "-in:C1 launch", "channel:COTHER launch"]) {
      expect((await f.reader.search({ query }, f.ctx)).status).toBe("access_denied");
    }
    expect((await f.reader.search({ query: "launch", channel: "GSECRET" }, f.ctx)).status).toBe("invalid_target");
    expect(f.auth).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    ["missing_scope", "access_denied"], ["not_allowed_token_type", "unsupported"], ["thread_not_found", "invalid_target"], ["ratelimited", "rate_limited"], ["secret-raw-error", "unavailable"],
  ])("distinguishes API failure %s from an empty result", async (error, status) => {
    const f = fixture(); f.history.mockResolvedValue({ ok: false, error, secret: "TOKEN" });
    const result = await f.reader.read("channel", {}, f.ctx);
    expect(result.status).toBe(status); expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("TOKEN"); expect(JSON.stringify(result)).not.toContain(error);
    expect(f.history).toHaveBeenCalledTimes(1); expect(f.replies).not.toHaveBeenCalled();
  });
  it("sanitizes thrown 429s with retry-after and performs no automatic retries", async () => {
    const f = fixture(); f.replies.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 30, token: "SECRET", message: "SECRET" });
    const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(result).toMatchObject({ status: "rate_limited", retryAfterSeconds: 30, messages: [] });
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(f.replies).toHaveBeenCalledTimes(1);
  });
  it("returns empty channel successfully but empty/invalid thread is not successful", async () => {
    const f = fixture(); expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", messages: [], complete: true, truncated: false });
    f.replies.mockResolvedValue({ ok: true, messages: [] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
  });
  it.each([
    { ...reply(2), channel: "GSECRET" }, { ...reply(2), team: "TEVIL" },
    { ...reply(2), thread_ts: reply(3).ts }, { ...reply(2), ts: "invalid" },
    { ...reply(2), text: undefined },
  ])("fails closed for returned message scope/integrity mismatch %j", async message => {
    const f = fixture(); f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, text: "root", reply_count: 1 }, message] });
    const result = await f.reader.read("thread", { ts: root }, f.ctx); expect(result.status).toBe("unavailable"); expect(result.messages).toEqual([]);
  });
  it("reads unthreaded parents with no reply_count, but unknown thread counts remain partial", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, user: "U1", text: "unthreaded original" }] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: true, truncated: false, messages: [{ text: "unthreaded original" }] });
    f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, thread_ts: root, user: "U1", text: "unknown count" }, reply(2)] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: false, truncated: true });
  });
  it("fails closed for conflicting repeated originals and bounds JSON-escaped text", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [ { ts: root, text: "root", reply_count: 1 }, reply(2), { ...reply(2), text: "conflicting original" } ] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
    f.history.mockResolvedValue({ ok: true, messages: Array.from({ length: 15 }, (_, n) => ({ ts: reply(n + 2).ts, user: "U1", text: "\\n\\\"\\\\".repeat(10_000) })) });
    const result = await f.reader.read("channel", {}, f.ctx);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages).toHaveLength(15); expect(result.messages.every(m => m.textTruncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100);
  });
  it("flags text truncation and missing replies rather than claiming completeness", async () => {
    const f = fixture(); f.replies.mockResolvedValue({ ok: true, messages: [ { ts: root, text: "😀".repeat(10_000), reply_count: 4 }, reply(2) ] });
    const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages[0]!.textTruncated).toBe(true); expect(Buffer.byteLength(result.messages[0]!.text)).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100);
    expect(result.messages[0]!.text).not.toContain("�");
  });
  it("opaque cursors bind actor/team/request/channel/kind/target, are one-use and recheck membership", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 2 }, reply(2)], has_more: true, response_metadata: { next_cursor: "RAW_SLACK_CURSOR" } });
    const first = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(first).toMatchObject({ complete: false, truncated: true, page: 1 });
    const cursor = first.nextCursor!; expect(cursor).not.toContain("RAW_SLACK_CURSOR"); expect(JSON.stringify(first)).not.toContain("RAW_SLACK_CURSOR");
    for (const changes of [{ userId: "UOTHER" }, { teamId: "TOTHER" }, { requestId: "event:other", threadTs: "1700000000.000001" }, { channel: "COTHER" }]) {
      expect((await f.reader.read("thread", { ts: root, cursor }, context(changes))).status).not.toBe("ok");
    }
    expect((await f.reader.read("channel", { cursor }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { ts: reply(2).ts, cursor }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { ts: root, cursor: "RAW_SLACK_CURSOR" }, f.ctx)).status).toBe("invalid_target");
    f.members.mockResolvedValueOnce({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("thread", { ts: root, cursor }, f.ctx)).status).toBe("access_denied");
    f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, text: "root", reply_count: 2 }, reply(3)] });
    const second = await f.reader.read("thread", { ts: root, cursor }, f.ctx);
    expect(second).toMatchObject({ complete: true, truncated: false, page: 2, nextCursor: null });
    expect(second.messages.map(m => m.ts)).toEqual([reply(3).ts]);
    expect(f.replies).toHaveBeenLastCalledWith({ channel: "C1", ts: root, limit: 14, cursor: "RAW_SLACK_CURSOR" });
    expect((await f.reader.read("thread", { ts: root, cursor }, f.ctx)).status).toBe("invalid_target");
  });
  it("bounds history to 4 explicit pages; each page ascending, next page older", async () => {
    const f = fixture(); f.history.mockImplementation(async () => ({ ok: true, messages: [
      { ts: `1700000000.${String(100 - f.history.mock.calls.length * 2).padStart(6, "0")}`, text: "recent", user: "U1" },
      { ts: `1700000000.${String(99 - f.history.mock.calls.length * 2).padStart(6, "0")}`, text: "older", bot_id: "B1" },
    ], has_more: true, response_metadata: { next_cursor: `next-${f.history.mock.calls.length}` } }));
    let cursor: string | undefined; let prior = "";
    for (let page = 1; page <= 4; page++) {
      const result = await f.reader.read("channel", cursor ? { cursor } : {}, f.ctx);
      expect(result).toMatchObject({ status: "ok", page, complete: false, truncated: true });
      expect(result.messages[0]!.ts < result.messages[1]!.ts).toBe(true);
      if (prior) expect(result.messages[1]!.ts < prior).toBe(true);
      prior = result.messages[0]!.ts; cursor = result.nextCursor ?? undefined;
      if (page < 4) expect(cursor).toBeTruthy(); else expect(result.nextCursor).toBeNull();
    }
    expect(f.history).toHaveBeenCalledTimes(4); expect(f.replies).not.toHaveBeenCalled();
  });
  it("marks has_more without cursor incomplete and rejects repeated API cursor loops", async () => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [], has_more: true });
    expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", complete: false, truncated: true, nextCursor: null });
    f.history.mockResolvedValue({ ok: true, messages: [], response_metadata: { next_cursor: "loop" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("unavailable");
  });
  it("allows only one in-flight continuation per opaque cursor", async () => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [], response_metadata: { next_cursor: "next" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.history.mockImplementationOnce(async () => { entered(); await hold; return { ok: true, messages: [] }; });
    const continuation = f.reader.read("channel", { cursor: first.nextCursor }, f.ctx);
    await started;
    expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target");
    release(); expect((await continuation).status).toBe("ok");
    expect(f.history).toHaveBeenCalledTimes(2);
  });
  it("expires cursors and never accepts arbitrary API cursors", async () => {
    const f = fixture(); f.history.mockResolvedValue({ ok: true, messages: [], response_metadata: { next_cursor: "next" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try { expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target"); }
    finally { clock.mockRestore(); }
  });
});
