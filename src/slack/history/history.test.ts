import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync, writeFileSync, readFileSync, realpathSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteHistory, type HistoryStore } from './index.js';
import type { ChatMessage } from '../../chat.js';
const signal = () => new AbortController().signal;
const key = (team = 'T1', channel = 'D1', root = '1.000001') => JSON.stringify([team, channel, root]);
const pair = (text = '한글 😀'): ChatMessage[] => [{ role: 'user', content: text }, { role: 'assistant', content: `답변 **${text}**` }];
const fixtures: string[] = [];
const stores: HistoryStore[] = [];
function fixture() { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'slack-history-')); fixtures.push(dir); return { dir, path: join(dir, 'history.sqlite') }; }
async function open(path: string, options: Parameters<typeof openSqliteHistory>[1] = {}) { const store = await openSqliteHistory(path, options); stores.push(store); return store; }
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('SQLite DM history', () => {
  it('restores real disk pairs, isolates tuple components, copies output, deletes durably', async () => {
    const { path } = fixture(); let store = await open(path);
    for (const k of [key(), key('T2'), key('T1', 'D2'), key('T1', 'D1', '2.000001')]) await store.set(k, pair(k), signal());
    await store.close(); store = await open(path);
    expect(await store.get(key(), signal())).toEqual(pair(key()));
    const copy = await store.get(key(), signal()); copy[0]!.content = 'changed';
    expect(await store.get(key(), signal())).toEqual(pair(key()));
    await store.delete(key(), signal()); await store.close(); store = await open(path);
    expect(await store.get(key(), signal())).toEqual([]);
    expect(await store.get(key('T2'), signal())).toEqual(pair(key('T2')));
  });
  it('preserves handler timestamps with one through six fractional digits across reopen', async () => {
    const { path } = fixture(); let store = await open(path);
    const accepted = ['101.0', '101.1', '101.000000', '101.000001'];
    for (const root of accepted) {
      await store.set(key('T1', 'D1', root), pair(root), signal());
      expect(await store.get(key('T1', 'D1', root), signal())).toEqual(pair(root));
    }
    await store.close(); store = await open(path);
    for (const root of accepted) expect(await store.get(key('T1', 'D1', root), signal())).toEqual(pair(root));
    // Timestamp strings remain distinct; no numeric normalization or float parsing.
    for (const root of ['101', '101.', '101.0000000', '.1', '101.-1', '101.x']) {
      await expect(store.set(key('T1', 'D1', root), pair(), signal())).rejects.toThrow('INPUT');
      await expect(store.get(key('T1', 'D1', root), signal())).rejects.toThrow('INPUT');
    }
    for (const invalid of [JSON.stringify(['T1', 'C1', '101.0']), JSON.stringify(['X1', 'D1', '101.0']), JSON.stringify(['T1', 'D1']), JSON.stringify(['T1', 'D1', 101.1])]) {
      await expect(store.set(invalid, pair(), signal())).rejects.toThrow('INPUT');
      await expect(store.get(invalid, signal())).rejects.toThrow('INPUT');
    }
  });
  it('applies seven-day default TTL and rejects unsafe option overrides before creating files', async () => {
    const { path } = fixture(); let now = 0; const store = await open(path, { now: () => now });
    await store.set(key(), pair(), signal()); now = 7 * 86_400_000 - 1;
    expect(await store.get(key(), signal())).toEqual(pair()); now++;
    expect(await store.get(key(), signal())).toEqual([]);
    const f = fixture();
    for (const options of [{ maxThreads: 129 }, { ttlMs: 0 }, { maxBytes: NaN }, { maxTurns: 13 }]) {
      await expect(open(f.path, options)).rejects.toThrow('OPTIONS');
    }
    expect(() => statSync(f.path)).toThrow();
  });
  it('enforces default 128-thread and 12-turn ceilings', async () => {
    const { path } = fixture(); let now = 0; const store = await open(path, { now: () => now++ });
    for (let i = 0; i < 129; i++) await store.set(key('T1', `D${i}`), pair(), signal());
    expect(await store.get(key('T1', 'D0'), signal())).toEqual([]);
    expect(await store.get(key('T1', 'D128'), signal())).toEqual(pair());
    const messages = Array.from({ length: 13 }, (_, i) => pair(String(i))).flat();
    await store.set(key(), messages, signal()); expect(await store.get(key(), signal())).toEqual(messages.slice(2));
  });
  it('TTL uses last successful set, not reads, and expires at exact boundary on reopen', async () => {
    const { path } = fixture(); let now = 10; let store = await open(path, { ttlMs: 100, now: () => now });
    await store.set(key(), pair(), signal()); now = 109;
    expect(await store.get(key(), signal())).toEqual(pair()); await store.close(); now = 110;
    store = await open(path, { ttlMs: 100, now: () => now }); expect(await store.get(key(), signal())).toEqual([]);
    await store.set(key(), pair(), signal()); now = 150; await store.set(key(), pair('new'), signal()); now = 249;
    expect(await store.get(key(), signal())).toEqual(pair('new'));
  });
  it('trims complete oldest pairs by turns and JSON UTF-8 bytes, never slices Unicode', async () => {
    const { path } = fixture(); const store = await open(path, { maxTurns: 2, threadBytes: 200 });
    await store.set(key(), [...pair('old'), ...pair('middle'), ...pair('😀')], signal());
    expect(await store.get(key(), signal())).toEqual([...pair('middle'), ...pair('😀')]);
    await store.set(key(), [...pair('x'.repeat(300)), ...pair('😀')], signal());
    expect(await store.get(key(), signal())).toEqual(pair('😀'));
    await store.set(key(), pair('x'.repeat(300)), signal()); expect(await store.get(key(), signal())).toEqual([]);
  });
  it('enforces count and aggregate quotas with deterministic oldest-set/key tie eviction', async () => {
    const { path } = fixture(); const store = await open(path, { maxThreads: 2, now: () => 10 });
    for (const k of [key('T3'), key('T2'), key('T1')]) await store.set(k, pair(), signal());
    expect(await store.get(key('T1'), signal())).toEqual([]); // binary key tie order
    expect(await store.get(key('T3'), signal())).toEqual(pair());
    await store.close(); const bytes = Buffer.byteLength(JSON.stringify(pair()));
    const smaller = await open(path, { maxBytes: bytes, now: () => 11 });
    expect(await smaller.get(key('T2'), signal())).toEqual([]);
    expect(await smaller.get(key('T3'), signal())).toEqual(pair());
  });
  it('rejects bad keys, incomplete/reversed/extra roles and malformed Unicode without modifying old pairs', async () => {
    const { path } = fixture(); const store = await open(path); await store.set(key(), pair(), signal());
    for (const bad of ['x', '{}', JSON.stringify(['T1', 'C1', '1.000001']), JSON.stringify(['T1', 'D1', 'root']), JSON.stringify(['T1', 'D1', '1.000001', 'U1'])]) {
      await expect(store.get(bad, signal())).rejects.toThrow('INPUT');
      await expect(store.delete(bad, signal())).rejects.toThrow('INPUT');
    }
    for (const bad of [[pair()[0]], [...pair()].reverse(), [{ role: 'system', content: 'secret' }, pair()[1]], [{ role: 'user', content: '\ud800' }, pair()[1]], [{ ...pair()[0], token: 'secret' }, pair()[1]]]) {
      await expect(store.set(key(), bad as ChatMessage[], signal())).rejects.toThrow('INPUT');
    }
    expect(await store.get(key(), signal())).toEqual(pair());
  });
  it('fences pre-abort, abort before commit with rollback, and all writes after close', async () => {
    const { path } = fixture(); const controller = new AbortController(); let trigger = false;
    const store = await open(path, { now: () => { if (trigger) controller.abort(); return 1; } });
    await store.set(key(), pair('original'), signal()); trigger = true;
    await expect(store.set(key(), pair('new'), controller.signal)).rejects.toThrow('ABORTED'); trigger = false;
    expect(await store.get(key(), signal())).toEqual(pair('original'));
    await expect(store.delete(key(), controller.signal)).rejects.toThrow('ABORTED');
    await expect(store.get(key(), controller.signal)).rejects.toThrow('ABORTED');
    await store.close(); await store.close();
    await expect(store.set(key(), pair(), signal())).rejects.toThrow('CLOSED');
    await expect(store.delete(key(), signal())).rejects.toThrow('CLOSED');
    const restored = await open(path, { now: () => 1 }); expect(await restored.get(key(), signal())).toEqual(pair('original'));
  });
  it('fails fast on busy database and rolls back without exposing SQLite/source errors', async () => {
    const { path } = fixture(); const store = await open(path); await store.set(key(), pair(), signal());
    const blocker = new DatabaseSync(path);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      await expect(store.set(key(), pair('secret'), signal())).rejects.toThrow('SLACK_HISTORY_DATABASE');
      blocker.exec('ROLLBACK');
      expect(await store.get(key(), signal())).toEqual(pair());
    } finally { blocker.close(); }
  });
  it('rejects corruption, invalid JSON, incompatible schema/version and unrelated tables', async () => {
    for (const alteration of ["UPDATE slack_history_entries SET payload = 'source-secret', bytes = 13", "UPDATE slack_history_entries SET payload = '[{}]', bytes = 4, updated = 0", 'UPDATE slack_history_entries SET updated = -1', 'CREATE TABLE unrelated (secret TEXT)', 'PRAGMA user_version = 2', 'DROP TABLE slack_history_meta; CREATE TABLE slack_history_meta (id INTEGER PRIMARY KEY, version INTEGER); INSERT INTO slack_history_meta VALUES(1,2)']) {
      const { path } = fixture(); const store = await open(path); await store.set(key(), pair(), signal()); await store.close();
      const db = new DatabaseSync(path); try { db.exec(alteration); } finally { db.close(); }
      await expect(open(path)).rejects.toThrow('SLACK_HISTORY_DATABASE');
    }
    const { path } = fixture(); writeFileSync(path, 'source-secret-not-sqlite', { mode: 0o600 });
    await expect(open(path)).rejects.toThrow('SLACK_HISTORY_DATABASE');
  });
  it('creates private files/directories, refuses symlinks, hardlinks and unsafe existing paths without chmod', async () => {
    const { dir } = fixture(); const path = join(dir, 'owned', 'history.sqlite'); const store = await open(path);
    expect(statSync(join(dir, 'owned')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(open(path)).rejects.toThrow('PATH'); await store.close();
    chmodSync(path, 0o644); await expect(open(path)).rejects.toThrow('PATH'); expect(statSync(path).mode & 0o777).toBe(0o644);
    chmodSync(path, 0o600);
    const f = fixture(); symlinkSync(path, f.path); await expect(open(f.path)).rejects.toThrow('PATH');
    const linked = fixture(); linkSync(path, linked.path); await expect(open(linked.path)).rejects.toThrow('PATH'); rmSync(linked.path);
    const ancestor = fixture(); symlinkSync(join(dir, 'owned'), join(ancestor.dir, 'alias')); await expect(open(join(ancestor.dir, 'alias', 'history.sqlite'))).rejects.toThrow('PATH');
    const g = fixture(); chmodSync(g.dir, 0o755); await expect(open(g.path)).rejects.toThrow('PATH'); expect(statSync(g.dir).mode & 0o777).toBe(0o755);
    const h = fixture(); writeFileSync(join(h.dir, 'unrelated'), 'keep'); await expect(open(h.path)).rejects.toThrow('PATH'); expect(readFileSync(join(h.dir, 'unrelated'), 'utf8')).toBe('keep');
  });
  it('keeps disk page growth bounded after repeated replacement and deletion', async () => {
    const { path } = fixture(); const store = await open(path);
    for (let i = 0; i < 160; i++) await store.set(key('T1', `D${i}`), pair('x'.repeat(20_000)), signal());
    expect(statSync(path).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    for (let i = 0; i < 160; i++) await store.delete(key('T1', `D${i}`), signal());
    expect(statSync(path).size).toBeLessThan(64 * 1024);
  });
});
