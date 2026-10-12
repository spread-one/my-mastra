import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { bindSlackReadContext, getSlackReadIdentity, getSlackSearchActionToken } from "./context.js";
import { isUsableSlackActionToken } from "./action-token-validation.js";

const secret = "DIAGNOSTIC_SECRET_not_a_standard_slack_token";
const identity = { userId: "U1", teamId: "T1", channel: "C1", requestId: "slack-event:synthetic", threadTs: "1700000000.000001" };

describe("trusted action-token validation and private binding", () => {
  it.each([
    [undefined, false], [null, false], [42, false], [{}, false], ["", false], ["white space", false],
    ["tab\t", false], ["\u0000", false], ["a".repeat(16_385), false], [secret, true], ["a".repeat(16_384), true],
    ["\u007f", true], ["\u00a0", true],
  ] as const)("preserves the existing binding validation boundary", (value, expected) => {
    const context = new RequestContext();
    bindSlackReadContext(context, identity, value);
    expect(!!getSlackSearchActionToken(context)).toBe(expected);
    expect(isUsableSlackActionToken(value)).toBe(expected);
    expect(getSlackReadIdentity(context)).toEqual(identity);
    expect(JSON.stringify(getSlackReadIdentity(context))).not.toContain(secret);
    expect(context.get("action_token")).toBeUndefined();
    expect(context.get("stage")).toBeUndefined();
  });

  it("does not serialize object tokens or accept forged RequestContext entries", () => {
    const execute = vi.fn(() => { throw new Error(secret); });
    const context = new RequestContext();
    bindSlackReadContext(context, identity, { toJSON: execute });
    expect(getSlackSearchActionToken(context)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    const forged = new RequestContext();
    forged.set("action_token", secret); forged.set("requestId", "FORGED");
    expect(getSlackReadIdentity(forged)).toBeUndefined();
    expect(getSlackSearchActionToken(forged)).toBeUndefined();
  });
});
