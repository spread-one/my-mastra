import { LogLevel, type Logger } from "@slack/web-api";
/** Even DEBUG HTTP/body diagnostics must not disclose event action_token. Sanitized failures are returned by tools. */
export const silentSlackLogger: Logger = Object.freeze({
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  setLevel: () => {}, setName: () => {}, getLevel: () => LogLevel.ERROR,
});
