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

/** Only an authenticated handler may call this; text/context.get() cannot bind authority. */
export function bindSlackReadContext(context: object, identity: SlackReadIdentity, actionToken?: unknown, signal?: AbortSignal): void {
  identities.set(context, Object.freeze({ userId: identity.userId, teamId: identity.teamId,
    channel: identity.channel, requestId: identity.requestId, threadTs: identity.threadTs }));
  actionTokens.delete(context);
  signals.delete(context);
  if (isUsableSlackActionToken(actionToken)) actionTokens.set(context, actionToken);
  if (signal) signals.set(context, signal);
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
