# Bounded persistent local Slack DM history

`src/slack/history/index.ts` exports `HistoryStore`, `HistoryOptions`, `HistoryError`,
and `openSqliteHistory(path, options?)`. Node 24's built-in `node:sqlite` is the only
storage dependency. Imports perform no filesystem, environment, or network work.
Production Slack startup opens this store before admission and handlers await get/set/delete under the invocation signal. Default local path: `.local/slack-history/history.sqlite` (gitignored), optional local `SLACK_HISTORY_DB`. Compose fixes `/var/lib/my-mastra/history/history.sqlite` in the named `my-mastra-history` volume. See [runtime-integration.md](runtime-integration.md).

```ts
import { openSqliteHistory } from './slack/history/index.js';
const history = await openSqliteHistory('/private/service-data/dm/history.sqlite');
const key = JSON.stringify([trustedTeamId, trustedDmChannelId, trustedThreadRoot]);
const previous = await history.get(key, signal);
// After successful DM execution/delivery, supply complete user/assistant pairs:
await history.set(key, [...previous,
  { role: 'user', content: acceptedUserText },
  { role: 'assistant', content: canonicalRedactedMarkdownAnswer },
], signal);
await history.delete(key, signal); // Explicit forget, not shutdown.
await history.close(); // Releases connection; does NOT clear disk history.
```

## Runtime integration contract

All `get`, `set`, `delete`, and `close` methods return promises. The implementation
executes bounded synchronous SQLite work without yielding; asynchronous signatures
allow later runtime injection without coupling to SQLite. Await every operation.
Runtime admission/per-thread serialization must encompass read, model generation,
delivery and set to prevent stale read/overwrite. The store is a snapshot repository,
not a conversation-event claim/dedupe implementation.

Keys must come exclusively from the authenticated handler, never model/tool output:
JSON tuple `[team, DM channel, thread root]`, with `T`/`D` uppercase alphanumeric Slack
IDs and a Slack timestamp (`digits.one-to-six-digits`), matching the existing trusted
handler contract. Timestamp strings are preserved exactly, not parsed as floating point
or normalized: `101.0` and `101.000000` remain distinct roots. Whitespace in tuple JSON is normalized.
Team, channel and root all isolate history; the trusted DM channel binds its actor.
The store cannot verify an actor or Slack authorization: handler authentication remains
mandatory. Channel (`C`/`G`) keys are rejected. Channel authoritative threads must
continue to fetch Slack context, never use this local store.

Only nonempty strings in alternating user/assistant pairs are accepted. Odd-length,
reversed, extra-field, tool/system-role and malformed Unicode payloads are rejected
before modification. Persist the canonical **redacted Markdown** answer, not renderer
blocks, tool transcripts, file grants, action tokens, credentials or source channel
history. Redaction and determination of successful completion are caller duties; the
store cannot infer these from text. No cancellation UI or new cancellation flow is added.

Stop admission, abort/drain jobs, then await `close()` on shutdown. A process-cache
clear must never call disk delete. Close is idempotent and fences subsequent access.
Signals are checked before operations and immediately before commit; pre-commit abort
rolls back the whole transaction. An abort cannot undo an already committed operation.
Synchronous SQLite blocks delivery of new event-loop aborts until it returns; this is
not a promise of mid-query preemption. Do not schedule post-shutdown writes.

## Bounds and eviction

Defaults: seven days since last successful `set`, 128 threads, 1,000,000 aggregate
JSON UTF-8 payload bytes, 48,000 JSON UTF-8 bytes/thread, 12 complete turns/thread.
The byte/count/turn defaults use existing `SLACK_LIMITS`; disk TTL intentionally differs
from the legacy 30-minute memory cache. Reads do not renew TTL or eviction recency.
`ttlMs`, `maxThreads`, `maxBytes`, `threadBytes`, `maxTurns` may only lower defaults
(positive safe integers). Production configuration does not raise these limits.
`now` is an injectable nonnegative integer epoch clock, primarily for tests.

Set validates at most 1,024 input messages / 1 MB content, retains newest turns, then
removes whole oldest pairs until serialized payload fits. No character/byte slicing
occurs. If no pair fits (or an empty list is supplied), set deletes that thread.
Global eviction is oldest successful-set timestamp, then binary canonical-key order
for ties; it may evict the new entry in a tie. TTL expires at `age >= ttlMs`; clock
rollback postpones expiry until the clock catches up. Cleanup runs on open and every
operation, not via a background timer. Expired records can remain on disk while stopped.
Lower limits on reopen discard expired/over-limit threads rather than rewrite them.
Delete removes a thread atomically, with quota/expiry cleanup in the same transaction.
`get` also uses a pruning write transaction: even reads acquire an immediate SQLite
lock, scan/validate bounded stored payloads and may delete expired entries. This adds
transaction/commit cost and means reads can fail fast on lock contention; they are not
read-only point lookups.

SQLite uses FULL synchronous commits, DELETE journaling (no accumulating WAL), FULL
auto-vacuum and secure-delete. Main DB page size is 4,096, maximum 1,024 pages (4 MiB),
including schema/index/free-page overhead. Freed pages are reclaimed at commit without
unbounded manual VACUUM loops. Transient rollback journal storage is additional: reserve
at least 8 MiB plus filesystem overhead for this dedicated directory. The logical 1 MB
limit covers message JSON, **not** keys, indexes or disk overhead. Inputs, queries and
scans are bounded; busy timeout is zero (fail fast, no retry loop). Disk I/O/fsync can
still stall on an unhealthy volume; this is not a hard real-time guarantee.

## Filesystem, schema and failures

Use a dedicated private POSIX directory on a local persistent volume, owned by the
service UID. Newly created directories are mode 0700 and DB files 0600 (or stricter
under umask). Existing directories/files are never chmod'ed. The final directory must
be private/owned and contain only the selected DB and its rollback journal. Symlink
components, nonregular DB/journal files, hardlinks, other owners, group/world access,
and oversized files are rejected. Supply a canonical symlink-free absolute path; e.g.
on macOS `/var` or `/tmp` aliases require resolving the trusted parent first. Ancestors
may be shared system directories; protect them against hostile replacement. Path checks
and SQLite open are not race-proof against an attacker able to replace ancestor paths
or an adversary running as the same UID. Do not use untrusted/user-chosen paths.

Version 1 initializes an empty SQLite database transactionally and owns only
`slack_history_meta` and `slack_history_entries`. Application ID, user version, exact
owned schema, metadata, SQLite quick-check and all bounded stored rows are validated
on open. Unrelated tables/views/triggers or incompatible versions are rejected, not
migrated/dropped. There is no older deployed version to migrate yet; future migrations
must be explicit transactions limited to these owned tables. Invalid JSON/keys/roles,
byte mismatches and corrupt records (even stale ones) fail closed rather than silently
feed model context or erase source data. Failed initialization may leave an empty owned
file, which may be safely reopened. There is no automatic destructive recovery.

Errors expose only `SLACK_HISTORY_INPUT`, `DATABASE`, `PATH`, `CLOSED`, `ABORTED`, or
`OPTIONS`, without SQL, source messages, filesystem paths or underlying error causes.
Callers must report generic operational failures without logging message/key contents.
A failed transaction preserves previous committed pairs; failed writes must not be
reported as durable success. Corruption requires stopping the service and operator
recovery from an approved backup, not deleting a production file automatically.

## Deployment, backups and limits of guarantees

**Single process / one store per canonical path** is required. A module-local registry
rejects duplicate opens, but is not a cross-process lease, distributed lock or a guarantee
against duplicate module copies. No shared PostgreSQL, network filesystem, production
DB operations or cross-process safety are provided. SQLite's locks only bound accidental
contention failures. Compose mounts a dedicated named persistent private local volume. The image seeds owner 1000/mode 0700 directories only for a NEW volume; no host directory chmod or volume deletion is performed. Replacement/rollback retain it.

SQLite at rest is **not encryption**. Use approved encrypted volumes if required. Restrict
backup access like live data. Back up only after stopping writes and closing the store
(or implement a separately reviewed SQLite online-backup procedure). Never copy just the
main file during a transaction. Test restore, validate schema, and keep backup retention
bounded to the same privacy policy: TTL/delete do not erase historical backups, snapshots,
SSD remnants or filesystem journals. secure-delete is not a forensic erasure guarantee.

This survives tested close/reopen and uses SQLite crash-recovery primitives; actual
power-loss durability depends on filesystem/storage honoring fsync. It does **not**
provide durable Slack exactly-once processing, request claims or atomic Slack-send+DB
commit. A crash between Slack delivery and set can lose a turn; retries can duplicate
responses. Handlers commit only after successful final delivery. Ordinary failed turns delete only their own DM key; abort/shutdown/history failures preserve previously committed pairs. History get or actor inconsistency failures refuse to generate a missing-context answer with a static history-unavailable notice. Set failure after a **confirmed accepted final delivery** is not an atomic Slack/DB transaction and cannot undo that Slack message. The handler preserves previous pairs and sends one best-effort static “답변은 전송했지만 대화 기록 저장에 실패했습니다…” ancillary notice, without retrying/reanswering or classifying it as a model failure (`history_save_failed` static log). This warning shares the separately bounded notice lifecycle (5s, concurrency 2, at most one per thread, no queue/recursive retry, stopped/aborted on shutdown). A deadline after confirmed delivery still cannot write late history. An ambiguous ordinary post or stream-stop response remains unconfirmed and suppresses additional answers/notices; confirmation is never inferred from an attempted write.

Shookie `database/src/conversations.ts`, `007_conversation_runtime.sql`, and
`shookie/src/slack/conversation-runtime.ts` were read-only design references for atomic
completed pairs and separation of authoritative channel context. Their PostgreSQL,
request-claim, cancellation and cache infrastructure was not copied or operated.

Validation: `npm test`, `npm run typecheck`, `npm run build` (each bounded to 60 seconds).
`revision-regressions.test.ts` additionally acquires a real second connection's `BEGIN IMMEDIATE` inside accepted ordinary-post and stream-stop callbacks: exactly one answer plus an accurate save-failure warning, previous disk pairs retained and reopened. It also updates a live stored payload to a corrupt row and verifies fail-closed **before chat**, without deleting that row. Confirmed-delivery deadline fencing and stalled warning5s/no-recursion are covered separately.

Tests use real SQLite in isolated private temporary directories, owned-fixture-only
cleanup, reopen restoration, TTL, quotas, tuple isolation, pair validation, abort/close
fencing, locking failures, corruption, incompatible schema, permissions and page growth.
