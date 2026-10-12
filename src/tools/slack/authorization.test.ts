import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import type { SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { authorizeCurrentSlackChannel, readAuthorizedSlackMessage } from "./authorization.js";
import { SlackReadAccessError } from "./errors.js";

const root = "1700000000.000001", reply = "1700000000.000002";
function fixture() {
  const context = new RequestContext(); bindSlackReadContext(context, { userId: "U1", teamId: "T1", channel: "C1", requestId: "event:1", threadTs: "1700000000.000001" }, "SECRET_ACTION");
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, is_private: false } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"] });
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: root, user: "U2", text: "SECRET_CONTENT", files: [{ id: "F1", url_private: "SECRET_URL", token: "SECRET" }] }] });
  const replies = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: root, text: "parent", files: [{ id: "FOTHER" }] }, { ts: reply, thread_ts: root, text: "reply", files: [{ id: "F2" }] }] });
  const client = { auth: { test: auth }, conversations: { info, members, history, replies } } as unknown as SlackReadClient;
  return { context, client, auth, info, members, history, replies };
}
describe("stable public Slack authorization/message bridge", () => {
  it("returns frozen token-free scope metadata but performs live checks on each operation", async () => {
    const f = fixture(); const access = await authorizeCurrentSlackChannel(f.client, f.context);
    expect(access).toEqual({ identity: { userId: "U1", teamId: "T1", channel: "C1", requestId: "event:1", threadTs: "1700000000.000001" }, channelId: "C1", kind: "public_channel", workspaceHost: "synthetic.slack.com" });
    expect(Object.isFrozen(access)).toBe(true); expect(Object.isFrozen(access.identity)).toBe(true);
    expect(JSON.stringify(access)).not.toContain("SECRET");
    f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: root })).rejects.toMatchObject({ status: "access_denied" });
    expect(f.history).not.toHaveBeenCalled(); expect(f.auth).toHaveBeenCalledTimes(2);
  });
  it("gets only the exact authorized message's file IDs, never bot client, file metadata, URLs or text", async () => {
    const f = fixture(); const message = await readAuthorizedSlackMessage(f.client, f.context, { messageTs: root });
    expect(message).toEqual({ channelId: "C1", messageTs: root, fileIds: ["F1"] });
    expect(Object.isFrozen(message)).toBe(true); expect(Object.isFrozen(message.fileIds)).toBe(true);
    expect(f.history).toHaveBeenCalledExactlyOnceWith({ channel: "C1", oldest: root, latest: root, inclusive: true, limit: 1 });
    expect(JSON.stringify(message)).not.toContain("SECRET"); expect(f.replies).not.toHaveBeenCalled();
  });
  it("uses a bounded exact reply lookup and never substitutes the parent's attachments", async () => {
    const f = fixture(); const message = await readAuthorizedSlackMessage(f.client, f.context, { messageTs: reply, threadTs: root });
    expect(message).toEqual({ channelId: "C1", messageTs: reply, threadTs: root, fileIds: ["F2"] });
    expect(f.replies).toHaveBeenCalledExactlyOnceWith({ channel: "C1", ts: root, oldest: reply, latest: reply, inclusive: true, limit: 15 });
    expect(f.history).not.toHaveBeenCalled();
  });
  it("denies fake/missing actors and arbitrary channels before API access", async () => {
    const f = fixture(); const fake = new RequestContext(); fake.set("userId", "U1"); fake.set("teamId", "T1"); fake.set("channel", "C1");
    await expect(authorizeCurrentSlackChannel(f.client, fake)).rejects.toMatchObject({ status: "access_denied" });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { channelId: "GSECRET", messageTs: root })).rejects.toMatchObject({ status: "access_denied" });
    expect(f.auth).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled();
  });
  it.each([{ messageTs: "1.2" }, { messageTs: root, threadTs: reply }, { messageTs: root, threadTs: "invalid" }])("strictly validates message/thread targets %j", async target => {
    const f = fixture(); await expect(readAuthorizedSlackMessage(f.client, f.context, target)).rejects.toMatchObject({ status: "invalid_target" }); expect(f.auth).not.toHaveBeenCalled();
  });
  it.each([
    [{ ts: reply, files: [{ id: "FSECRET" }] }], [], [{ ts: root, channel: "GSECRET", files: [{ id: "FSECRET" }] }],
    [{ ts: root, team: "TOTHER", files: [{ id: "FSECRET" }] }], [{ ts: root, thread_ts: reply }], [{ ts: root, files: [{ id: "invalid" }] }],
  ].map(messages => ({ messages })))("rejects mismatched response/message/file provenance %j", async ({ messages }) => {
    const f = fixture(); f.history.mockResolvedValue({ ok: true, messages });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: root })).rejects.toBeInstanceOf(SlackReadAccessError);
  });
  it("never accepts partial/duplicate exact lookup and sanitizes unsupported/errors", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: reply, thread_ts: root }, { ts: reply, thread_ts: root }] });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: reply, threadTs: root })).rejects.toMatchObject({ status: "invalid_target" });
    f.history.mockResolvedValueOnce({ ok: true, messages: [{ ts: root }], response_metadata: { next_cursor: "SECRET_CURSOR" } });
    await expect(readAuthorizedSlackMessage(f.client, f.context, { messageTs: root })).rejects.toMatchObject({ status: "unavailable" });
    f.history.mockRejectedValueOnce({ data: { error: "not_allowed_token_type" }, message: "SECRET_TOKEN" });
    try { await readAuthorizedSlackMessage(f.client, f.context, { messageTs: root }); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(SlackReadAccessError); expect(JSON.stringify(error)).not.toContain("SECRET"); }
    expect(f.replies).toHaveBeenCalledTimes(1); expect(f.history).toHaveBeenCalledTimes(2);
  });
  it("requires matching bot team, forbids shared channels and verifies DM peer on the public bridge", async () => {
    const f = fixture(); f.auth.mockResolvedValueOnce({ ok: true, bot_id: "B1", team_id: "TOTHER" });
    await expect(authorizeCurrentSlackChannel(f.client, f.context)).rejects.toMatchObject({ status: "access_denied" });
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "C1", is_channel: true, is_shared: true } });
    await expect(authorizeCurrentSlackChannel(f.client, f.context)).rejects.toMatchObject({ status: "access_denied" });
    const dm = new RequestContext(); bindSlackReadContext(dm, { userId: "U1", teamId: "T1", channel: "D1", requestId: "dm", threadTs: "1700000000.000001" });
    f.info.mockResolvedValueOnce({ ok: true, channel: { id: "D1", is_im: true, user: "UOTHER" } });
    await expect(readAuthorizedSlackMessage(f.client, dm, { messageTs: root })).rejects.toMatchObject({ status: "access_denied" });
  });
});
