import { describe, expect, it, vi } from "vitest";
import { LogLevel, WebClient } from "@slack/web-api";
import { silentSlackLogger } from "./sdk-logger.js";

describe("real SDK action_token logging suppression", () => {
  it("sends the event token in the API request but never prints request/response bodies at DEBUG", async () => {
    const token = "SYNTHETIC_EVENT_ACTION_SECRET";
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const requests: string[] = [];
    try {
      const client = new WebClient("synthetic-bot", { logger: silentSlackLogger, logLevel: LogLevel.DEBUG,
        rejectRateLimitedCalls: true, retryConfig: { retries: 0 }, timeout: 10_000,
        adapter: async config => {
          requests.push(String(config.data));
          return { config, request: { path: "/api/assistant.search.context" }, status: 200, statusText: "OK", headers: {}, data: { ok: true, results: { messages: [] }, action_token: token } };
        },
      });
      const result = await client.apiCall("assistant.search.context", { action_token: token, query: 'in:<#C1> "launch"', limit: 20 });
      expect(result.ok).toBe(true); expect(requests).toHaveLength(1); expect(requests[0]!).toContain(token);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
});
