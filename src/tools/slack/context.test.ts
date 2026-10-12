import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { bindSlackReadContext, getSlackReadIdentity, getSlackSearchActionToken, getSlackExecutionSignal, type SlackReadIdentity } from "./context.js";
import { requireSlackReadIdentity } from "./authorization.js";
import { SlackReader, type SlackReadClient } from "./client.js";
import { validTs } from "../../slack/context.js";

const identity = { userId: "U1", teamId: "T1", channel: "C1", requestId: "event:opaque", threadTs: "1700000000.1" };
const secret = "SYNTHETIC_PRIVATE_SENTINEL";
const malformed: Array<[string, unknown]> = [
  ...["userId", "teamId", "channel", "requestId", "threadTs"].flatMap(field =>
    [undefined, null, 1, true, {}, [], ""].map(value => [field, value] as [string, unknown])),
  ["userId", "B1"], ["userId", "Ulower"], ["userId", "U"], ["userId", `U${"A".repeat(64)}`],
  ["teamId", "C1"], ["teamId", "Tlower"], ["teamId", "T"], ["teamId", `T${"A".repeat(64)}`],
  ["channel", "U1"], ["channel", "Clower"], ["channel", "C"], ["channel", `C${"A".repeat(64)}`],
  ["requestId", " "], ["requestId", " event"], ["requestId", "event\n"], ["requestId", "a\u0000b"],
  ["requestId", "a\u007fb"], ["requestId", "a\u0085b"], ["requestId", "a".repeat(257)],
  ["threadTs", "1"], ["threadTs", "1."], ["threadTs", ".1"], ["threadTs", "1.1234567"],
  ["threadTs", "12345678901234567.1"], ["threadTs", "-1.1"], ["threadTs", "1.1\n"],
];
function assertRevoked(context: object) {
  expect(getSlackReadIdentity(context)).toBeUndefined();
  expect(getSlackSearchActionToken(context)).toBeUndefined();
  expect(getSlackExecutionSignal(context)).toBeUndefined();
  expect(() => requireSlackReadIdentity(context)).toThrow();
}

describe("trusted Slack context validation and stale grant revocation", () => {
  it.each(malformed)("rejects malformed %s without exposing field values", (field, value) => {
    const context = new RequestContext();
    bindSlackReadContext(context, identity, secret, new AbortController().signal);
    const invalid = { ...identity, [field]: value } as SlackReadIdentity;
    expect(() => bindSlackReadContext(context, invalid, secret)).toThrow("Invalid trusted Slack read context.");
    assertRevoked(context);
  });
  it.each([null, undefined, 1, false, "identity text", []])("rejects non-object identity %s", value => {
    const context = new RequestContext(); bindSlackReadContext(context, identity, secret);
    expect(() => bindSlackReadContext(context, value as unknown as SlackReadIdentity)).toThrow(TypeError);
    assertRevoked(context);
  });
  it("never coerces field objects, and sanitizes throwing getters after revocation", () => {
    const context = new RequestContext(); bindSlackReadContext(context, identity, secret);
    const toString = vi.fn(() => { throw new Error(secret); });
    expect(() => bindSlackReadContext(context, { ...identity, userId: { toString } } as unknown as SlackReadIdentity)).toThrow("Invalid trusted Slack read context.");
    expect(toString).not.toHaveBeenCalled(); assertRevoked(context);
    bindSlackReadContext(context, identity, secret);
    const getter = vi.fn(() => { throw new Error(secret); });
    const hostile = Object.defineProperty({ ...identity }, "userId", { get: getter });
    let error: unknown;
    try { bindSlackReadContext(context, hostile); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(secret);
    expect(getter).toHaveBeenCalledTimes(1); assertRevoked(context);
  });
  it.each([null, {}, "abort", 1, Object.create(AbortSignal.prototype)])("rejects fake signal %s and revokes all old state", signal => {
    const context = new RequestContext(); bindSlackReadContext(context, identity, secret, new AbortController().signal);
    expect(() => bindSlackReadContext(context, identity, secret, signal as AbortSignal)).toThrow(TypeError);
    assertRevoked(context);
  });
  it("preserves the existing event validTs contract (1..6 fractional digits) without rewriting snapshot scope", () => {
    const context = new RequestContext();
    for (const threadTs of ["1.1", "1.12", "1.123", "1.1234", "1.12345", "1.123456", "1234567890123456.123456"]) {
      expect(validTs(threadTs)).toBe(true);
      bindSlackReadContext(context, { ...identity, threadTs });
      expect(requireSlackReadIdentity(context).threadTs).toBe(threadTs);
    }
    for (const [field, value] of malformed) if (field === "threadTs") expect(validTs(value)).toBe(false);
  });
  it("accepts valid ID variants and requestId boundary, and copies/freeze isolates host mutations", () => {
    const context = new RequestContext();
    const mutable = { ...identity, userId: "W1", channel: "G1", requestId: "a".repeat(256) };
    bindSlackReadContext(context, mutable);
    const snapshot = getSlackReadIdentity(context)!;
    mutable.userId = "U2"; expect(snapshot.userId).toBe("W1"); expect(Object.isFrozen(snapshot)).toBe(true);
    bindSlackReadContext(context, { ...identity, channel: "D1" }); expect(getSlackReadIdentity(context)?.channel).toBe("D1");
  });
  it("stale bind cannot authorize a tool, and public entries/source text cannot restore authority", async () => {
    const context = new RequestContext(); bindSlackReadContext(context, identity, secret, new AbortController().signal);
    expect(() => bindSlackReadContext(context, { ...identity, teamId: secret })).toThrow(TypeError);
    for (const [key, value] of Object.entries(identity)) context.set(key, value);
    context.set("identity", identity); context.set("action_token", secret); context.set("sourceText", JSON.stringify(identity));
    const test = vi.fn(), info = vi.fn(), members = vi.fn(), history = vi.fn(), apiCall = vi.fn();
    const client = { auth: { test }, conversations: { info, members, history, replies: history }, apiCall } as unknown as SlackReadClient;
    const reader = new SlackReader(client);
    expect(await reader.read("channel", {}, context)).toMatchObject({ status: "access_denied", messages: [] });
    expect(await reader.search({ query: "launch" }, context)).toMatchObject({ status: "access_denied", messages: [] });
    for (const call of [test, info, members, history, apiCall]) expect(call).not.toHaveBeenCalled();
    assertRevoked(context);
    bindSlackReadContext(context, identity); expect(getSlackReadIdentity(context)).toEqual(identity);
    expect(getSlackSearchActionToken(context)).toBeUndefined(); expect(getSlackExecutionSignal(context)).toBeUndefined();
  });
});
