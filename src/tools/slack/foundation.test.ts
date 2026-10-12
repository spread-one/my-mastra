import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { bindSlackReadContext, getSlackExecutionSignal, getSlackReadIdentity, createSlackReadClient, createSlackTools, authorizeCurrentSlackChannel, readAuthorizedSlackMessage } from "./index.js";
import { SlackReader, type SlackReadClient } from "./client.js";

const root = "1700000000.000001";
const identity = { userId: "U1", teamId: "T1", channel: "C1", requestId: "event", threadTs: root };
const token = "SYNTHETIC_ACTION_SECRET";
function fixture() {
  const context = new RequestContext(); bindSlackReadContext(context, identity, token);
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", context_team_id: "T1", is_channel: true, is_private: false, is_group: false } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"] });
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: root, text: "body", files: [{ id: "F1" }] }] });
  const apiCall = vi.fn().mockResolvedValue({ ok: true, results: { messages: [] } });
  const client = { auth: { test: auth }, conversations: { info, members, history, replies: history }, apiCall } as unknown as SlackReadClient;
  return { context, auth, info, members, history, apiCall, client, reader: new SlackReader(client) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("foundation trusted context and bounded transports", () => {
  it("executes all tools through an actual SDK with injected HTTP, no live Slack installation", async () => {
    const context = new RequestContext(); bindSlackReadContext(context, identity, token);
    const endpoints: string[] = [];
    const client = createSlackReadClient({ token: "synthetic-bot" }, { adapter: async config => {
      const endpoint = config.url!.split("/").at(-1)!; endpoints.push(endpoint);
      expect(config.signal).toBeDefined();
      const data = endpoint === "auth.test" ? { ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" }
        : endpoint === "conversations.info" ? { ok: true, channel: { id: "C1", context_team_id: "T1", is_channel: true, is_group: false, is_private: false, name: "general" } }
        : endpoint === "conversations.members" ? { ok: true, members: ["U1"] }
        : endpoint === "assistant.search.context" ? { ok: true, results: { messages: [] } }
        : { ok: true, messages: [{ ts: root, text: "body", files: [{ id: "F1" }] }] };
      return { config, request: {}, status: 200, statusText: "OK", headers: {}, data };
    } });
    const reader = new SlackReader(client);
    expect(await reader.read("channel", {}, context)).toMatchObject({ status: "ok", complete: true });
    expect(await reader.read("thread", { ts: root }, context)).toMatchObject({ status: "ok", complete: true });
    expect(await reader.search({ query: "launch" }, context)).toMatchObject({ status: "ok", messages: [], complete: true });
    expect(await readAuthorizedSlackMessage(client, context, { messageTs: root })).toMatchObject({ fileIds: ["F1"] });
    expect(endpoints).toContain("assistant.search.context");
    expect(Object.keys(createSlackTools(client)).sort()).toEqual(["slack_read_channel", "slack_read_thread", "slack_search"]);
  });
  it("rejects actual SDK 429 without retrying or logging transport bodies", async () => {
    let calls = 0;
    const context = new RequestContext(); bindSlackReadContext(context, identity, token);
    const client = createSlackReadClient({ token: "synthetic-bot" }, { adapter: async config => {
      calls++;
      return { config, request: {}, status: 429, statusText: "rate limited", headers: { "retry-after": "37" }, data: { secret: token } };
    } });
    expect(await new SlackReader(client).read("channel", {}, context)).toMatchObject({ status: "rate_limited", retryAfterSeconds: 37 });
    expect(calls).toBe(1);
  });
  it("uses only the WeakMap signal, does not dispatch after a pre-abort, and clears on rebind", async () => {
    const f = fixture(), controller = new AbortController();
    f.context.set("signal", new AbortController().signal);
    bindSlackReadContext(f.context, identity, token, controller.signal); controller.abort(token);
    expect(getSlackExecutionSignal(f.context)).toBe(controller.signal);
    expect(await f.reader.read("channel", {}, f.context)).toMatchObject({ status: "unavailable", messages: [] });
    expect(f.auth).not.toHaveBeenCalled();
    bindSlackReadContext(f.context, identity, token);
    expect(getSlackExecutionSignal(f.context)).toBeUndefined();
    expect(getSlackReadIdentity(f.context)).toEqual(identity);
    expect(await f.reader.read("channel", {}, f.context)).toMatchObject({ status: "ok" });
  });
  it("aborts real SDK-shaped HTTP transport and ignores late results", async () => {
    const controller = new AbortController(), context = new RequestContext();
    bindSlackReadContext(context, identity, token, controller.signal);
    let started!: () => void, httpSignal: { aborted: boolean } | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const client = createSlackReadClient({ token: "synthetic-bot" }, { adapter: async config => {
      httpSignal = config.signal; started();
      return new Promise((_resolve, reject) => { config.signal!.addEventListener!("abort", () => reject(new Error(token))); });
    } });
    const work = new SlackReader(client).read("channel", {}, context);
    await ready; controller.abort(token);
    expect(await work).toMatchObject({ status: "unavailable", messages: [] });
    expect(httpSignal?.aborted).toBe(true);
  });
  it("bounds hanging injected calls without trusting model timeout hints", async () => {
    vi.useFakeTimers(); const f = fixture(); f.auth.mockImplementationOnce(() => new Promise(() => {}));
    const work = f.reader.read("channel", {}, f.context);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await work).toMatchObject({ status: "unavailable", messages: [] });
    expect(f.auth).toHaveBeenCalledTimes(1); expect(f.history).not.toHaveBeenCalled();
  });
  it.each(["auth", "info", "members"] as const)("rejects warning-bearing live %s authorization", async endpoint => {
    const f = fixture(); const mock = f[endpoint];
    const original = await mock(); mock.mockClear();
    mock.mockResolvedValueOnce({ ...original, response_metadata: { warnings: ["partial"] } });
    await expect(authorizeCurrentSlackChannel(f.client, f.context)).rejects.toMatchObject({ status: "unavailable" });
    expect(f.history).not.toHaveBeenCalled();
  });
  it("binds continuation to trusted thread scope, not public context data", async () => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "body" }], response_metadata: { next_cursor: "raw" } });
    const first = await f.reader.read("channel", {}, f.context);
    bindSlackReadContext(f.context, { ...identity, threadTs: "1700000000.000002" }, token);
    expect(await f.reader.read("channel", { cursor: first.nextCursor }, f.context)).toMatchObject({ status: "invalid_target" });
  });
  it("never retains credential-bearing raw cursor or request binding", async () => {
    const f = fixture(); f.apiCall.mockResolvedValueOnce({ ok: true, results: { messages: [] }, next_cursor: token });
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unavailable" });
    expect(await f.reader.search({ query: token }, f.context)).toMatchObject({ status: "access_denied" });
    f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "body" }], response_metadata: { next_cursor: token } });
    expect(await f.reader.read("channel", {}, f.context)).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify([...((f.reader as unknown as { cursors: Map<string, unknown> }).cursors)])).not.toContain(token);
  });
  it("reports absent SDK search transport as unsupported, never empty success or a scan", async () => {
    const f = fixture(); delete f.client.apiCall;
    expect(await f.reader.search({ query: "launch" }, f.context)).toMatchObject({ status: "unsupported", complete: false });
    expect(f.history).not.toHaveBeenCalled();
  });
});
