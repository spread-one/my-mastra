# Slack read tools foundation

This PR ports Shookie `src/tools/slack/**` read-only from main
`96df8d480c8e639f89d941e6abc79d69678b0ce4` (PR91, PR108 and PR116 included).
The original checkout is not modified. The library foundation is now wired into production Slack in `src/slack/tools.ts`, `model.ts`, `run.ts`, with the updated manifest. This is **not actual Slack installation validation**; see [runtime-integration.md](runtime-integration.md).
It does not implement cancellation commands, OAuth, auto-join, fallback history scans,
attachment downloads, or privileged alternate credentials.

## Optional human-readable context

Automatic context and registered channel/thread/search tools add optional `channelName` and `author.displayName` only after live access validation. Channel names reuse validated `conversations.info`; authors use the same installed bot credential's `users.info`, or `bots.info` only when no user author exists. No email, arbitrary profile fields, persistent cache or permission grant is retained. User names prefer inspected primitive profile `display_name`, `real_name`, then `name`; missing/unsafe metadata uses generic participant/bot wording, never guessed roles or names.

Each enrichment batch has at most eight unique author lookups, two concurrent requests and an 800 ms display deadline. Late results are discarded; physical SDK requests remain bounded by no-retry transport timeout. Accessors/proxies are not executed. Redacted, JSON-escaped names count toward final whole-context/tool JSON budgets. IDs remain API addresses and authorization evidence, not unsolicited normal-answer diagnostics. Meaningful partial-reading limitations remain natural-language caveats. The manifest adds bot `users:read`; existing installations still require manual reinstall/reapproval. No installation or live Slack/provider checks were performed.

## Integration API

Import from `src/tools/slack/index.ts` (compiled `dist/tools/slack/index.js`).

```ts
createSlackReadClient(bot: Pick<WebClient, "token">,
  options?: Pick<WebClientOptions, "adapter">): SlackReadClient
createSlackTools(client: SlackReadClient): {
  slack_read_channel: Tool; slack_read_thread: Tool; slack_search: Tool;
}
// createSlackReadTools is a compatibility alias.

bindSlackReadContext(context: object, identity: SlackReadIdentity,
  actionToken?: unknown, signal?: AbortSignal): void
getSlackReadIdentity(context?: object): SlackReadIdentity | undefined
getSlackExecutionSignal(context?: object): AbortSignal | undefined

// All fields required; immutable defensive copy, not RequestContext entries.
type SlackReadIdentity = Readonly<{
  userId: string; teamId: string; channel: string;
  requestId: string; threadTs: string;
}>
```

Only the authenticated Bolt handler may bind identity, using the live event's actor,
workspace, current channel, request ID and parent/event timestamp. The binder validates actor (`U`/`W`), team (`T`) and channel (`C`/`G`/`D`) IDs
with 1–63 uppercase alphanumeric suffix characters. `requestId` must be a nonempty
opaque string of at most 256 UTF-16 code units without whitespace/control characters.
`threadTs` follows the existing handler `validTs` contract (1–16 integer digits and
1–6 fractional digits), is preserved without normalization, and binds continuation scope and
provides the common trusted scope for subsequent snapshot/file integration. It does
not restrict explicit thread reads to that root or grant access to other channels.
No source message, channel hint, model input, or public `RequestContext.set()` entry
can establish identity or an action token. These APIs are trusted host APIs, not tools.
Every bind attempt first revokes the previous identity, action token and signal.
Invalid identity/object/field or non-native optional AbortSignal throws a value-free
`TypeError("Invalid trusted Slack read context.")`; a failed rebind cannot leave a
stale grant. Invalid/missing action tokens continue to mean unsupported search rather
than invalid identity. Successful binding stores a frozen defensive primitive copy.
Callers must use one context per
request and must not rebind it while a request is in flight. Explicit message/thread tool
addresses still use six fractional digits; the handler-bound scope timestamp accepts
1–6 digits for compatibility with authenticated events.

Authenticated runtime wiring (implemented by the handler/model adapter):

```ts
const readClient = createSlackReadClient(boltClient); // same bot credential only
const tools = createSlackTools(readClient);          // registered in the Slack runtime
bindSlackReadContext(requestContext,
  { userId, teamId, channel, requestId, threadTs },
  authenticatedEvent.action_token, trustedAbortSignal);
// Mastra execute receives this SAME object as context.requestContext.
```

`getSlackSearchActionToken` is private transport plumbing (not exported by the
integration entry point). Do not expose it through model context, logging, telemetry,
cache, snapshots or persisted records. Tokens are held only in a request-object WeakMap.
The preserved action-token predicate accepts only a primitive nonempty string of at
most 16,384 UTF-16 code units with no U+0000–U+0020 character. It intentionally does
not reject DEL (U+007F), NBSP (U+00A0), or every other Unicode whitespace/control
character; this is token-shape compatibility, not proof of authenticity or validity.
Missing/invalid/expired tokens are not an empty search result. Text echoes are redacted; credential-bearing cursor/binding/metadata is rejected before output or
continuation storage. Do not log SDK request/response/error bodies in the caller either.

## Live authorization adapters for attachment integration

```ts
async authorizeCurrentSlackChannel(client: SlackReadClient,
  context: object | undefined,
  target?: { channelId?: string; workspaceHost?: string }
): Promise<CurrentSlackAccess>
// Frozen { identity, channelId, kind: "public_channel" | "private_channel" | "im",
//          workspaceHost?: string }

async readAuthorizedSlackMessage(client: SlackReadClient,
  context: object | undefined,
  target: { messageTs: string; threadTs?: string; channelId?: string }
): Promise<AuthorizedSlackMessage>
// Frozen { channelId, messageTs, threadTs?: string, fileIds: readonly string[] }
```

Adapters throw `SlackReadAccessError` with sanitized `.status` and `.result`;
tools return the corresponding structured `ReadResult`. No raw exception/response
should be forwarded to the model. Missing public context authority fails closed.

Authorization runs live on **every operation/page**, using bot `auth.test`, matching
workspace, exact channel metadata, no shared/org-shared/external channel, and actor
membership (at most three pages of 200 members). An IM must name the actor as its peer;
MPIMs are denied. The bot's actual read scopes/access are checked by Slack on the
requested history/replies call, not inferred from snippets. Warning-bearing auth,
info or membership responses and malformed/partial message provenance are rejected.
A returned `CurrentSlackAccess` is informational, **not a reusable capability**.

`readAuthorizedSlackMessage` is **current-channel only**. It performs an inclusive
exact-timestamp history lookup, or explicit-parent replies lookup (max 15 records),
requires exactly one match and rejects pagination, warnings, mismatched channel/team,
wrong parent, malformed timestamps and invalid file IDs. Each file record must be a
non-null plain object (ordinary or null prototype, no Proxy/array/class instance), with
an own data-property `id` that is a primitive string matching `F[A-Z0-9]{1,63}`.
No coercion or ID getter runs; the frozen deduplicated result contains primitive ID
snapshots only. Reply lookup requires its parent timestamp. It returns verified file
IDs only, not metadata, URLs, credentials, downloads or a durable access grant. File/image integration must reauthorize each
operation and validate its own download transport and file metadata.

## Read semantics

- `slack_read_channel`: only current-channel history, 15 messages/page, max four
  explicit pages. It does not expand every thread. `complete` describes the bounded
  history range, not all replies or a transactionally consistent snapshot.
- `slack_read_thread`: explicit channel+parent timestamp or strict same-workspace
  HTTPS Slack permalink. Cross-channel targets must be nonshared public channels,
  with live actor membership on every page. No URL is fetched; URLs are parsed only.
  Parent, reply provenance, duplicate fingerprints and reply counts are checked;
  missing replies, changing counts and clipped text mean partial, not verified full
  thread. Max four pages of 15 records (14 requested replies plus parent).
- `slack_search`: official `assistant.search.context` only, bot+authenticated event
  action token. Origin must be an authorized public channel. Search is workspace
  public channels, or one selected permitted nonshared public channel. Target
  membership is **not** a fabricated prerequisite for RTS: Slack's event-token
  search filters the actor's access. Full-thread reads separately require membership.
  No `search.all`/`search.messages`, OAuth or history scan fallback.

Search accepts literal words (no user-supplied Slack operators). Max 20 primary
matches/page, four pages, 40 delivered records/page including contextual records.
Exact workspace/channel/timestamp/permalink consistency is validated; navigation
query hints are validated then removed, never converted to thread authority.
A permalink query parent must be at or before its linked message. Independently of
permalink presence/query hints, every search primary and context `thread_ts` must be
at or before that record's timestamp. These comparisons use normalized six-digit
integer timestamps, not floating point.
`searchMatch`, `contextForTs`, `contextPosition` distinguish matches and context.
Snippets/context are **not** verified full threads. Compatible unequal primary/context
representations preserve primary text and omit alternate context with `partial`;
for unequal-text primary/context observations, conflicting known metadata fails closed;
same-role text changes also fail closed. The deliberate equal-text cross-role exception
is preserved: equal primary/context text hashes skip cross-role metadata compatibility
checks, even if known author/kind/thread metadata differ. This is legacy acceptance,
not a metadata equivalence assertion or a full-thread grant; scope, address and
parent-not-after-message validation still apply to every record. No source synthesis.
Optional `channelName` comes from live channel metadata, is display-only untrusted
data, and never affects permission, addressing, query or identity. Display `#name`
when present, otherwise `<#channelID>`; keep returned permalink as provenance.

`status: ok` with zero records is a successfully validated empty result. Unsupported
SDK transport/install/token, access denial, 429, malformed/warning/partial failure
are distinct statuses with `complete: false`. `complete` on search covers keyword
search pagination, not all channel history. Check `truncated`, `textTruncated`,
`complete`, `nextCursor` and limits before describing a result as exhaustive.

Continuation handles are random, single-use on successful consumption, actor/team/
origin/request/**thread scope**/operation/target/query/limit bound, ten-minute expiry,
max four pages and 1,000 in-memory handles per reader/searcher. Raw Slack cursors stay
private. State stores only scope, validated cursor, bounded IDs, role hashes and
completion markers; no original message text/action token. Concurrent consumption,
changed scope, repeated Slack cursors, expired/replayed handles are rejected. Failed
continuations keep their seed immutable and unlock it for an explicit retry.

## Transport and installation constraints

Use `createSlackReadClient(boltClient)` in production: it constructs a separate silent
SDK with **the same existing bot credential**, fixed Slack API host, absolute URL
overrides disabled, HTTP timeout 10s, SDK retries disabled and immediate 429 rejection.
It never reads env/config/credentials at module import. The optional `adapter` is for
trusted synthetic HTTP injection, not model-controlled endpoints. It forwards a
trusted operation AbortSignal through SDK request interception to HTTP transport.
No OAuth or user-token substitution occurs; live bot/team checks still apply.

Each operation additionally bounds total waiting to 15s and at most 32 API calls.
Trusted abort/deadline stops further calls, discards late responses and releases
cursor locks without propagating private abort reasons. There is no cancellation
package or model cancellation argument. A structural injected `SlackReadClient` or
raw caller-owned WebClient is accepted for reuse/testing; waiting is still bounded,
but the library **cannot disable retries/logging or physically abort arbitrary
caller-owned transports**. Such clients must already be silent, timeout-bounded and
no-retry. Prefer the explicit production adapter rather than default Bolt SDK retry
behavior. The library never mutates a shared Bolt client's settings.

Install-specific AI/Real-time Search enablement, bot `search:read.public`, event
`action_token` availability and relevant conversation read scopes must be checked
manually against the actual installation after scopes are reapproved. This foundation does not promise RTS on every
Slack installation or infer authorization from a search snippet.

## Validation

Ported regressions plus synthetic tests cover membership/team/bot failures, private/
shared isolation, roles, cursor binding/replay, metadata/permalink consistency,
missing/expired token, unsupported search, warnings/partial failure, secret-free
output/state, trusted signals/timeouts, and the actual Slack SDK with injected HTTP.
Run `npm test`, `npm run typecheck`, `npm run build` (each bounded to 60 seconds).
These tests make no live Slack requests and are not an installation/E2E claim.

### Revision validation coverage (binding hardening)

Full suite execution includes `authorization.test.ts` (exact-message file provenance,
current-channel live checks), `client.test.ts` (history/thread validation and cursor
bounds), `cross-channel.test.ts` (target isolation), `search.test.ts` (native search,
role metadata/fingerprints, permalink consistency, unsupported/error/partial responses
and pagination), `search-channel-names.test.ts` (display-only names), diagnostic/token
privacy regressions, and `foundation.test.ts` (real SDK-shaped injected HTTP, abort,
429/no retry, trusted scopes and warnings). New `context.test.ts` covers bad-bind field
and object types, bounded request IDs, 1–6 digit timestamp compatibility, fake signals,
throwing getters/noncoercion, defensive copying, stale identity/token/signal revocation,
and denial before network dispatch despite forged public context/source text.
This is exact automated test coverage, not a claim of independent full-scope review;
main retains review scope, supplemental review, design and merge decisions.

### Supplemental review delta

`review-regressions.test.ts` covers coercible/nonprimitive file IDs, invalid file
record types, getter/coercion nonexecution, duplicate primitive snapshots, future
permalink roots rejected before network dispatch, missing/queryless search provenance,
primary/context future-root denial (including equal-text observations), valid equal/
earlier roots, and integer comparisons beyond floating-point precision. The existing
equal-text conflicting-metadata regression retains that compatibility behavior using
a different but temporally possible earlier root. Supplemental reviewer feedback is
addressed by these checks; main owns independent delta review and acceptance.
