import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { dirname, basename, resolve, parse, join } from 'node:path';
import type { ChatMessage } from '../../chat.js';
import { SLACK_LIMITS } from '../limits.js';

export interface HistoryStore {
  get(key: string, signal: AbortSignal): Promise<ChatMessage[]>;
  set(key: string, messages: ChatMessage[], signal: AbortSignal): Promise<void>;
  delete(key: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface HistoryOptions {
  ttlMs?: number;
  maxThreads?: number;
  maxBytes?: number;
  threadBytes?: number;
  maxTurns?: number;
  /** Injectable clock for tests; must return nonnegative integer epoch milliseconds. */
  now?: () => number;
}
export class HistoryError extends Error {
  constructor(public readonly code: 'INPUT' | 'DATABASE' | 'PATH' | 'CLOSED' | 'ABORTED' | 'OPTIONS') {
    super(`SLACK_HISTORY_${code}`);
  }
}
const DAY = 86_400_000;
const FILE_LIMIT = 4 * 1024 * 1024;
const active = new Set<string>();
const META = 'CREATE TABLE slack_history_meta (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL CHECK(version = 1))';
const DATA = 'CREATE TABLE slack_history_entries (key TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL, updated INTEGER NOT NULL)';
type Row = { key: string; payload: string; bytes: number; updated: number };

function keyOf(key: string): string {
  if (typeof key !== 'string' || key.length > 256) throw new HistoryError('INPUT');
  let tuple: unknown;
  try { tuple = JSON.parse(key); } catch { throw new HistoryError('INPUT'); }
  if (!Array.isArray(tuple) || tuple.length !== 3 ||
      typeof tuple[0] !== 'string' || !/^T[A-Z0-9]{1,63}$/.test(tuple[0]) ||
      typeof tuple[1] !== 'string' || !/^D[A-Z0-9]{1,63}$/.test(tuple[1]) ||
      typeof tuple[2] !== 'string' || !/^\d{1,16}\.\d{6}$/.test(tuple[2])) throw new HistoryError('INPUT');
  return JSON.stringify(tuple);
}
function validMessages(value: unknown): asserts value is ChatMessage[] {
  if (!Array.isArray(value) || value.length % 2 || value.length > 1024) throw new HistoryError('INPUT');
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const m = value[i];
    if (!m || typeof m !== 'object' || Object.keys(m).sort().join(',') !== 'content,role' ||
        m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' || !m.content.trim() ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(m.content)) throw new HistoryError('INPUT');
    total += Buffer.byteLength(m.content);
    if (total > SLACK_LIMITS.dmBytes) throw new HistoryError('INPUT');
  }
}
function privatePath(path: string): void {
  const root = parse(path).root;
  let current = root;
  const parts = dirname(path).slice(root.length).split('/').filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new HistoryError('PATH');
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HistoryError('PATH');
  }
  const parent = lstatSync(dirname(path));
  if ((parent.mode & 0o077) || parent.uid !== process.getuid?.()) throw new HistoryError('PATH');
  const name = basename(path);
  // Dedicated private directory: SQLite sidecars cannot collide with unrelated files.
  for (const entry of readdirSync(dirname(path))) {
    if (entry !== name && entry !== `${name}-journal`) throw new HistoryError('PATH');
    const stat = lstatSync(join(dirname(path), entry));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) ||
        stat.uid !== process.getuid?.() || stat.size > FILE_LIMIT) throw new HistoryError('PATH');
  }
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new HistoryError('PATH');
  }
}
function ceiling(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) throw new HistoryError('OPTIONS');
  return result;
}

/** Single-process, private local volume only. Importing this module performs no I/O. */
export async function openSqliteHistory(path: string, options: HistoryOptions = {}): Promise<HistoryStore> {
  const ttl = ceiling(options.ttlMs, 7 * DAY);
  const count = ceiling(options.maxThreads, SLACK_LIMITS.dmCount);
  const aggregate = ceiling(options.maxBytes, SLACK_LIMITS.dmBytes);
  const thread = ceiling(options.threadBytes, SLACK_LIMITS.dmThreadBytes);
  const turns = ceiling(options.maxTurns, SLACK_LIMITS.dmTurns);
  const now = options.now ?? Date.now;
  if (typeof path !== 'string' || !path || path.includes('\0') || path === ':memory:') throw new HistoryError('PATH');
  path = resolve(path);
  if (active.has(path)) throw new HistoryError('PATH');
  let db: DatabaseSync;
  try { privatePath(path); db = new DatabaseSync(path, { timeout: 0 }); }
  catch (e) { throw e instanceof HistoryError ? e : new HistoryError('PATH'); }
  active.add(path);
  let closed = false;
  const time = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw new HistoryError('OPTIONS');
    return t;
  };
  const check = (signal: AbortSignal) => {
    if (closed) throw new HistoryError('CLOSED');
    if (signal.aborted) throw new HistoryError('ABORTED');
  };
  const transaction = <T>(signal: AbortSignal, fn: () => T): T => {
    check(signal);
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE'); begun = true;
      const result = fn();
      check(signal); // Last checkpoint immediately before synchronous COMMIT.
      db.exec('COMMIT'); begun = false;
      return result;
    } catch (e) {
      if (begun) { try { db.exec('ROLLBACK'); } catch { /* Never expose SQLite/source errors. */ } }
      throw e instanceof HistoryError ? e : new HistoryError('DATABASE');
    }
  };
  const rows = (): Row[] => {
    const stats = db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes, coalesce(max(length(CAST(payload AS BLOB))),0) AS largest FROM slack_history_entries').get()!;
    if (Number(stats.count) > SLACK_LIMITS.dmCount || Number(stats.bytes) > SLACK_LIMITS.dmBytes || Number(stats.largest) > SLACK_LIMITS.dmThreadBytes) throw new HistoryError('DATABASE');
    const result = db.prepare('SELECT key,payload,bytes,updated FROM slack_history_entries ORDER BY updated ASC, key COLLATE BINARY ASC').all() as Row[];
    for (const row of result) {
      try {
        if (keyOf(row.key) !== row.key || !Number.isSafeInteger(row.updated) || row.updated < 0 ||
            row.bytes !== Buffer.byteLength(row.payload)) throw new Error();
        const messages: unknown = JSON.parse(row.payload);
        validMessages(messages);
        if (!messages.length || messages.length > SLACK_LIMITS.dmTurns * 2) throw new Error();
      } catch { throw new HistoryError('DATABASE'); }
    }
    return result;
  };
  const remove = (key: string) => { db.prepare('DELETE FROM slack_history_entries WHERE key = ?').run(key); };
  const prune = (t: number) => {
    const live: Row[] = [];
    for (const row of rows()) {
      if (t - row.updated >= ttl || row.bytes > thread || (JSON.parse(row.payload) as ChatMessage[]).length > turns * 2) remove(row.key);
      else live.push(row);
    }
    let total = live.reduce((n, row) => n + row.bytes, 0);
    while (live.length > count || total > aggregate) { const row = live.shift()!; total -= row.bytes; remove(row.key); }
  };
  try {
    // No WAL growth; fixed page ceiling + full auto-vacuum reclaim freed pages on commit.
    db.exec('PRAGMA busy_timeout = 0; PRAGMA trusted_schema = OFF');
    const objects = db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!objects.length) {
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 0 ||
          db.prepare('PRAGMA application_id').get()?.application_id !== 0) throw new HistoryError('DATABASE');
      db.exec('PRAGMA page_size = 4096; PRAGMA auto_vacuum = FULL');
      transaction(new AbortController().signal, () => { db.exec(`${META}; ${DATA}; INSERT INTO slack_history_meta VALUES (1,1); PRAGMA user_version = 1; PRAGMA application_id = 1397245005`); });
    } else if (objects.length !== 2 || objects[0]?.name !== 'slack_history_entries' || objects[0]?.sql !== DATA ||
               objects[1]?.name !== 'slack_history_meta' || objects[1]?.sql !== META) throw new HistoryError('DATABASE');
    const metadata = db.prepare('SELECT id,version FROM slack_history_meta').all();
    if (metadata.length !== 1 || metadata[0]?.id !== 1 || metadata[0]?.version !== 1 ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
        db.prepare('PRAGMA application_id').get()?.application_id !== 1397245005 ||
        db.prepare('PRAGMA page_size').get()?.page_size !== 4096 ||
        db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum !== 1 ||
        db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new HistoryError('DATABASE');
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA max_page_count = 1024');
    transaction(new AbortController().signal, () => prune(time()));
  } catch {
    db.close(); active.delete(path); throw new HistoryError('DATABASE');
  }
  return {
    async get(key, signal) {
      check(signal); key = keyOf(key);
      return transaction(signal, () => {
        prune(time());
        const row = db.prepare('SELECT payload FROM slack_history_entries WHERE key = ?').get(key);
        return row ? JSON.parse(row.payload as string) as ChatMessage[] : [];
      });
    },
    async set(key, messages, signal) {
      check(signal); key = keyOf(key); validMessages(messages);
      const bounded = messages.slice(-turns * 2).map(m => ({ role: m.role, content: m.content }));
      let payload = JSON.stringify(bounded);
      while (bounded.length && Buffer.byteLength(payload) > Math.min(thread, aggregate)) {
        bounded.splice(0, 2); payload = JSON.stringify(bounded);
      }
      transaction(signal, () => {
        const t = time(); prune(t); remove(key);
        if (bounded.length) db.prepare('INSERT INTO slack_history_entries VALUES (?,?,?,?)').run(key, payload, Buffer.byteLength(payload), t);
        // Validate and evict after insertion, but temporary totals may exceed the global ceiling.
        const live = db.prepare('SELECT key,bytes FROM slack_history_entries ORDER BY updated ASC,key COLLATE BINARY ASC').all();
        let total = live.reduce((n, row) => n + Number(row.bytes), 0);
        while (live.length > count || total > aggregate) { const row = live.shift()!; total -= Number(row.bytes); remove(row.key as string); }
      });
    },
    async delete(key, signal) { check(signal); key = keyOf(key); transaction(signal, () => { prune(time()); remove(key); }); },
    async close() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch { throw new HistoryError('DATABASE'); }
      finally { active.delete(path); }
    },
  };
}
