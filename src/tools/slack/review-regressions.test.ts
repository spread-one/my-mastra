import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { bindSlackReadContext } from "./context.js";
import { readAuthorizedSlackMessage } from "./authorization.js";
import { SlackReader, type SlackReadClient } from "./client.js";

const ts = (n: number) => `1700000000.${String(n).padStart(6, "0")}`;
const permalink = (timestamp: string) => `https://synthetic.slack.com/archives/C1/p${timestamp.replace(".", "")}`;
function match(timestamp = ts(2)) {
  return { channel_id: "C1", team_id: "T1", message_ts: timestamp, content: "match", author_user_id: "U2", is_author_bot: false };
}
function fixture() {
  const context = new RequestContext();
  bindSlackReadContext(context, { userId: "U1", teamId: "T1", channel: "C1", requestId: "review-event", threadTs: ts(1) }, "SYNTHETIC_ACTION_SECRET");
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", context_team_id: "T1", is_channel: true, is_private: false, is_group: false } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"] });
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: ts(1), text: "body", files: [{ id: "F1" }] }] });
  const replies = vi.fn(), apiCall = vi.fn();
  const client = { auth: { test: auth }, conversations: { info, members, history, replies }, apiCall } as unknown as SlackReadClient;
  return { context, auth, info, members, history, replies, apiCall, client, reader: new SlackReader(client) };
}

describe("review delta: exact-message primitive file provenance", () => {
  it.each([
    ["coercible array", ["F1"]], ["number", 1], ["null", null], ["boolean", true], ["missing", undefined],
    ["coercible object", { toString: () => "F1" }], ["boxed string", new String("F1")],
  ])("rejects %s ID without returning nested/coercible values", async (_label, id) => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: ts(1), files: [{ id }] }] });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: ts(1) })).rejects.toMatchObject({ status: "unavailable" });
  });
  it.each([
    ["null", null], ["array", ["F1"]], ["primitive string", "F1"], ["number", 1],
    ["class instance", new (class File { id = "F1"; })()], ["inherited ID", Object.create({ id: "F1" })],
    ["proxy", new Proxy({ id: "F1" }, {})],
  ])("rejects non-plain file record %s", async (_label, file) => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: ts(1), files: [file] }] });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: ts(1) })).rejects.toMatchObject({ status: "unavailable" });
  });
  it("never invokes ID getters or coercion and freezes deduplicated primitive snapshots", async () => {
    const f = fixture(), getter = vi.fn(() => "F1"), toString = vi.fn(() => "F1");
    for (const file of [Object.defineProperty({}, "id", { get: getter }), { id: { toString } }]) {
      f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: ts(1), files: [file] }] });
      await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: ts(1) })).rejects.toMatchObject({ status: "unavailable" });
    }
    expect(getter).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled();
    const file = { id: "F1" };
    f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: ts(1), files: [file, { id: "F1" }, { id: "F2" }, Object.assign(Object.create(null), { id: "F2" })] }] });
    const authorized = await readAuthorizedSlackMessage(f.client, f.context, { messageTs: ts(1) });
    file.id = "FCHANGED";
    expect(authorized.fileIds).toEqual(["F1", "F2"]);
    expect(authorized.fileIds.every(id => typeof id === "string")).toBe(true);
    expect(Object.isFrozen(authorized.fileIds)).toBe(true);
  });
});

describe("review delta: integer parent/message temporal provenance", () => {
  it.each([
    [ts(2), ts(3)], ["9007199254740993.000002", "9007199254740993.000003"],
    ["9007199254740992.999999", "9007199254740993.000000"],
  ])("rejects permalink message %s with future parent %s before dispatch", async (messageTs, parent) => {
    const f = fixture();
    expect(await f.reader.read("thread", { url: `${permalink(messageTs)}?thread_ts=${parent}` }, f.context)).toMatchObject({ status: "invalid_target", messages: [] });
    expect(f.auth).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([ts(1), ts(2)])("preserves equal/earlier permitted permalink root %s", async parent => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: parent, text: "root", reply_count: 0 }] });
    expect(await f.reader.read("thread", { url: `${permalink(ts(2))}?thread_ts=${parent}` }, f.context)).toMatchObject({ status: "ok", source: { channel: "C1", threadTs: parent } });
    expect(f.replies).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", ts: parent }));
  });
  it.each(["missing", "queryless", "with-query"])("rejects future primary metadata with %s permalink", async link => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match(), thread_ts: ts(3),
      ...(link === "missing" ? {} : { permalink: permalink(ts(2)) + (link === "with-query" ? `?thread_ts=${ts(3)}` : "") }) }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
  });
  it.each([ts(1), ts(2)])("preserves valid primary root %s without/queryless permalink", async parent => {
    for (const link of [undefined, permalink(ts(2))]) {
      const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match(), thread_ts: parent, ...(link ? { permalink: link } : {}) }] } });
      expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", messages: [{ threadTs: parent }] });
    }
  });
  it.each(["before", "after"] as const)("rejects future %s context root without primary thread metadata", async position => {
    const f = fixture(), contextTs = position === "before" ? ts(1) : ts(3);
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match(), context_messages: { [position]: [{ ts: contextTs, text: "context", thread_ts: ts(4) }] } }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
  });
  it.each(["before", "after"] as const)("preserves equal/earlier %s context roots", async position => {
    const contextTs = position === "before" ? ts(1) : ts(3);
    for (const parent of [ts(0), contextTs]) {
      const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match(), context_messages: { [position]: [{ ts: contextTs, text: "context", thread_ts: parent }] } }] } });
      const result = await f.reader.search({ query: "launch" }, f.context);
      expect(result.status).toBe("ok"); expect(result.messages.find(m => !m.searchMatch)?.threadTs).toBe(parent);
    }
  });
  it("rejects future parent even in equal-text primary/context observations", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [match(), { ...match(ts(4)), context_messages: { before: [{ ts: ts(2), text: "match", thread_ts: ts(3) }] } }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
  });
  it("compares normalized search timestamps beyond floating point precision", async () => {
    const f = fixture();
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match("9007199254740993.000002"), thread_ts: "9007199254740993.000003" }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [{ ...match("9007199254740993.1"), thread_ts: "9007199254740993.01" }] } });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "ok", messages: [{ ts: "9007199254740993.100000", threadTs: "9007199254740993.010000" }] });
  });
});
