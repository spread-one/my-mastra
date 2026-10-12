import { isUsableSlackActionToken } from "./action-token-validation.js";

export type SlackReadIdentity = Readonly<{
  userId: string;
  teamId: string;
  channel: string;
  requestId: string;
  threadTs: string;
}>;
const identities = new WeakMap<object, SlackReadIdentity>();
// Private transport state, never RequestContext entries, model arguments or cursor state.
const actionTokens = new WeakMap<object, string>();
const signals = new WeakMap<object, AbortSignal>();

/** Same trusted event timestamp contract as src/slack/context.ts validTs; do not normalize scope. */
export function isSlackReadScopeTs(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,16}\.[0-9]{1,6}$/.test(value);
}
function id(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function validSignal(value: unknown): value is AbortSignal {
  if (!(value instanceof AbortSignal)) return false;
  // Check native brand too: Object.create(AbortSignal.prototype) is not a usable signal.
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(value);
  return true;
}
/** Only an authenticated handler may call this; text/context.get() cannot bind authority.
 * Every attempt revokes old grants first. Invalid input throws a value-free TypeError.
 */
export function bindSlackReadContext(context: object, identity: SlackReadIdentity, actionToken?: unknown, signal?: AbortSignal): void {
  identities.delete(context);
  actionTokens.delete(context);
  signals.delete(context);
  try {
    if (context === null || (typeof context !== "object" && typeof context !== "function") ||
        identity === null || typeof identity !== "object" || Array.isArray(identity)) throw new Error();
    // Read each field once; only inert validated primitives reach the frozen snapshot.
    const { userId, teamId, channel, requestId, threadTs } = identity;
    if (!id(userId, /^[UW][A-Z0-9]{1,63}$/) || !id(teamId, /^T[A-Z0-9]{1,63}$/) ||
        !id(channel, /^[CGD][A-Z0-9]{1,63}$/) || typeof requestId !== "string" ||
        requestId.length === 0 || requestId.length > 256 || /[\u0000-\u0020\u007f-\u009f]/.test(requestId) ||
        !isSlackReadScopeTs(threadTs) || (signal !== undefined && !validSignal(signal))) throw new Error();
    identities.set(context, Object.freeze({ userId, teamId, channel, requestId, threadTs }));
    if (isUsableSlackActionToken(actionToken)) actionTokens.set(context, actionToken);
    if (signal !== undefined) signals.set(context, signal);
  } catch {
    identities.delete(context);
    actionTokens.delete(context);
    signals.delete(context);
    throw new TypeError("Invalid trusted Slack read context.");
  }
}
/** Internal transport only; deliberately not re-exported by index.ts. */
export function getSlackSearchActionToken(context?: object): string | undefined {
  return context ? actionTokens.get(context) : undefined;
}
export function getSlackReadIdentity(context?: object): SlackReadIdentity | undefined {
  return context ? identities.get(context) : undefined;
}
export function getSlackExecutionSignal(context?: object): AbortSignal | undefined {
  return context ? signals.get(context) : undefined;
}
