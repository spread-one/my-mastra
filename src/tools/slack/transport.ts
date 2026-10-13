import { AsyncLocalStorage } from "node:async_hooks";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { silentSlackLogger } from "./sdk-logger.js";
import type { SlackReadClient } from "./client.js";
import { getSlackExecutionSignal } from "./context.js";
import { unavailable } from "./errors.js";

export const slackTransportLimits = Object.freeze({ operationTimeoutMs: 15_000, maxCalls: 32 });
const scoped = new WeakSet<object>();
const transportSignals = new AsyncLocalStorage<AbortSignal>();

/** Explicit production adapter: same Bolt bot credential, fixed Slack host, silent bounded no-retry SDK. */
export function createSlackReadClient(bot: Pick<WebClient, "token">, options: Pick<WebClientOptions, "adapter"> = {}): SlackReadClient {
  if (!bot.token) unavailable();
  return new WebClient(bot.token, {
    ...options, logger: silentSlackLogger, timeout: 10_000, retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true, allowAbsoluteUrls: false, attachOriginalToWebAPIRequestError: false,
    requestInterceptor: config => {
      const signal = transportSignals.getStore();
      if (signal) config.signal = signal;
      return config;
    },
  });
}

/** Bound waits and discard late responses. SDK instances must also have bounded, no-retry HTTP options. */
export function scopedSlackClient(client: SlackReadClient, context?: object): SlackReadClient {
  if (scoped.has(client)) return client;
  const signal = getSlackExecutionSignal(context);
  const deadline = Date.now() + slackTransportLimits.operationTimeoutMs;
  let calls = 0;
  async function call<T>(invoke: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0 || ++calls > slackTransportLimits.maxCalls) unavailable();
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: boolean, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(value); else resolve(value as T);
      };
      // Do not propagate abort reasons: a caller reason can contain private data.
      const abort = () => { controller.abort(); try { unavailable(); } catch (e) { finish(true, e); } };
      const timer = setTimeout(abort, remaining);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // Attach rejection handlers even after expiry; no detached unhandled rejection or state writes.
      Promise.resolve().then(() => {
        if (settled) return undefined as T;
        return transportSignals.run(controller.signal, invoke);
      }).then(value => finish(false, value), error => finish(true, error));
    });
  }
  const result = {
    auth: { test: (...args: Parameters<SlackReadClient["auth"]["test"]>) => call(() => client.auth.test(...args)) },
    conversations: {
      info: (...args: Parameters<SlackReadClient["conversations"]["info"]>) => call(() => client.conversations.info(...args)),
      members: (...args: Parameters<SlackReadClient["conversations"]["members"]>) => call(() => client.conversations.members(...args)),
      history: (...args: Parameters<SlackReadClient["conversations"]["history"]>) => call(() => client.conversations.history(...args)),
      replies: (...args: Parameters<SlackReadClient["conversations"]["replies"]>) => call(() => client.conversations.replies(...args)),
    },
    ...(client.users ? { users: { info: (args: { user: string }) => call(() => client.users!.info(args)) } } : {}),
    ...(client.bots ? { bots: { info: (args: { bot: string }) => call(() => client.bots!.info(args)) } } : {}),
    ...(client.apiCall ? { apiCall: (...args: Parameters<NonNullable<SlackReadClient["apiCall"]>>) => call(() => client.apiCall!(...args)) } : {}),
  } as SlackReadClient;
  scoped.add(result);
  return result;
}
