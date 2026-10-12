// Adapted with permission from user-owned Shookie PR90 (src/tools/web/content.ts).
import { randomUUID } from 'node:crypto';
import { WebError } from './network.js';

export const CONTENT_LIMITS = {
  ttlMs: 10 * 60_000, entries: 64, totalBytes: 16 * 1024 * 1024,
  actorEntries: 8, actorBytes: 4 * 1024 * 1024,
  outputBytes: 256 * 1024, textChars: 30_000, textBytes: 90_000, matches: 20, queryChars: 400,
  snippetChars: 1000, searchTextChars: 20_000, searchTextBytes: 60_000,
} as const;
export type ContextReader = { get(key: string): unknown };
type Scope = { binding: string; actor: string };
export type Source = { originalUrl: string; finalUrl: string; fetchedAt: string; contentType: string; title: string };
type Snapshot = Readonly<Source & { text: string; scope: Scope; expires: number; bytes: number; timer: ReturnType<typeof setTimeout> }>;

// Only runtime RequestContext, never tool arguments or downloaded metadata, defines identity.
export function contentScope(context?: ContextReader): Scope | undefined {
  try {
    if (!context || typeof context.get !== 'function') return undefined;
    const values = ['teamId', 'userId', 'channel', 'threadTs'].map((key) => context.get(key));
    if (!values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x20\x7f]/u.test(value))) return undefined;
    return { binding: JSON.stringify(values), actor: JSON.stringify(values.slice(0, 2)) };
  } catch { return undefined; }
}

// Process-wide cache: creating another tool set cannot bypass global/actor quotas.
// Charged bytes conservatively cover UTF-16 strings + metadata + per-entry overhead.
// No line index, tombstone or unbounded actor map is retained. A bounded, unref'ed
// timer per entry releases idle expired text; every operation also prunes/checks TTL.
export class ContentStore {
  private entries = new Map<string, Snapshot>();
  private bytes = 0;
  constructor(private limits: { ttlMs: number; entries: number; totalBytes: number; actorEntries: number; actorBytes: number } = CONTENT_LIMITS, private now = Date.now) {}
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry) { clearTimeout(entry.timer); this.bytes -= entry.bytes; this.entries.delete(id); }
  }
  private prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now >= entry.expires) this.remove(id);
  }
  put(scope: Scope, source: Source, text: string): { contentId: string; expiresAt: string } | undefined {
    this.prune();
    const bytes = 1024 + 2 * (text.length + Object.values(source).join('').length + scope.binding.length + scope.actor.length);
    const actorEntries = [...this.entries.values()].filter((entry) => entry.scope.actor === scope.actor);
    if (bytes > this.limits.totalBytes || bytes > this.limits.actorBytes || this.limits.entries < 1 ||
        actorEntries.length >= this.limits.actorEntries || actorEntries.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > this.limits.actorBytes) return undefined;
    while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.totalBytes) this.remove(this.entries.keys().next().value!);
    const contentId = randomUUID();
    const expires = this.now() + this.limits.ttlMs;
    const timer = setTimeout(() => this.remove(contentId), this.limits.ttlMs);
    timer.unref();
    // Detach slices: V8 substring backing stores must not retain a much larger
    // pre-trim/HTML document or title outside the charged memory budget.
    const copy = (value: string) => Buffer.from(value, 'utf16le').toString('utf16le');
    const detachedSource = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, copy(value)])) as Source;
    this.entries.set(contentId, Object.freeze({ ...detachedSource, text: copy(text), scope: Object.freeze({ binding: copy(scope.binding), actor: copy(scope.actor) }), expires, bytes, timer }));
    this.bytes += bytes;
    return { contentId, expiresAt: new Date(expires).toISOString() };
  }
  get(contentId: string, scope?: Scope): Snapshot {
    this.prune();
    if (!scope) throw new WebError('CONTENT_CONTEXT_REQUIRED');
    const entry = this.entries.get(contentId);
    // Unknown, expired, evicted and foreign IDs share one error; no existence oracle.
    if (!entry || entry.scope.binding !== scope.binding) throw new WebError('CONTENT_UNAVAILABLE');
    return entry;
  }
}
export const contentStore = new ContentStore();

function splitsPair(text: string, offset: number) {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!);
}
export function validateOffset(text: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || splitsPair(text, offset)) throw new WebError('INVALID_OFFSET');
}
function lineAt(text: string, offset: number) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
  return line;
}
export function textWindow(text: string, offset: number, maxChars: number, maxBytes: number = CONTENT_LIMITS.textBytes) {
  validateOffset(text, offset);
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || !Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new WebError('INVALID_REQUEST');
  let end = Math.min(text.length, offset + maxChars);
  if (splitsPair(text, end)) end--;
  // Linear scan avoids repeated encoding/slicing if a tighter byte cap is used.
  let bytes = 0;
  let byteEnd = offset;
  for (const char of text.slice(offset, end)) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size; byteEnd += char.length;
  }
  end = byteEnd;
  const piece = text.slice(offset, end);
  return { text: piece, offset, endOffset: end, nextOffset: end < text.length ? end : null,
    totalChars: text.length, totalBytes: Buffer.byteLength(text, 'utf8'), offsetUnit: 'utf16_code_units' as const,
    lines: piece ? { start: lineAt(text, offset), end: lineAt(text, end - 1) } : { start: 0, end: 0 },
    complete: end === text.length, truncated: end < text.length };
}
export function sourceOf(entry: Source): Source {
  return { originalUrl: entry.originalUrl, finalUrl: entry.finalUrl, fetchedAt: entry.fetchedAt, contentType: entry.contentType, title: entry.title };
}

export function findLiteral(text: string, literal: string, offset: number, count: number) {
  validateOffset(text, offset);
  if (!literal || literal.length > CONTENT_LIMITS.queryChars || !Number.isSafeInteger(count) || count < 1 || count > CONTENT_LIMITS.matches) throw new WebError('INVALID_REQUEST');
  const matches: { offset: number; endOffset: number; lines: { start: number; end: number }; snippet: ReturnType<typeof textWindow> }[] = [];
  let cursor = offset;
  while (matches.length < count) {
    const found = text.indexOf(literal, cursor);
    if (found < 0) break;
    const end = found + literal.length;
    // Reject malformed surrogate queries at the schema; also require code point boundaries.
    if (splitsPair(text, found) || splitsPair(text, end)) { cursor = found + 1; continue; }
    const snippet = textWindow(text, found, CONTENT_LIMITS.snippetChars);
    matches.push({ offset: found, endOffset: end, lines: { start: lineAt(text, found), end: lineAt(text, end - 1) }, snippet });
    cursor = end; // Non-overlapping, case-sensitive literal matches only.
  }
  const truncated = matches.length === count && text.indexOf(literal, cursor) >= 0;
  return { matches, nextOffset: truncated ? cursor : null, complete: !truncated, truncated,
    offset, totalChars: text.length, totalBytes: Buffer.byteLength(text, 'utf8'), offsetUnit: 'utf16_code_units' as const };
}
