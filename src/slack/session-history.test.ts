import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock('@slack/bolt', () => ({ LogLevel: { ERROR: 'error' },
  SocketModeReceiver: class { client = Object.assign(new EventEmitter(), { websocket: { isActive: () => true } }); },
  App: class { client: { token: string }; start = sdk.start; stop = sdk.stop;
    constructor(options: { token: string }) { this.client = { token: options.token }; } event() {} error() {} },
}));
import { createSlackSession, runSlack } from './run.js';
import { openSqliteHistory } from './history/index.js';
import { HISTORY_ERROR_TEXT } from './handlers.js';
const dirs: string[] = [];
const path = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'session-history-')); dirs.push(dir); return join(dir, 'history.sqlite'); };
afterEach(() => { sdk.start.mockReset().mockResolvedValue(undefined); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
const config = { botToken: 'xoxb-synthetic', appToken: 'xapp-synthetic', deepseekApiKey: 'synthetic', model: 'deepseek-chat' };
it('production session opens private SQLite before admission, closes on startup failure and retains disk on shutdown/restart', async () => {
  const historyPath = path(), signal = new AbortController().signal, key = '["T1","D1","100.0"]';
  const original = await openSqliteHistory(historyPath);
  await original.set(key, [{ role: 'user', content: '{"author":{"userId":"U1"},"text":"hello"}' }, { role: 'assistant', content: '**canonical**' }], signal); await original.close();
  sdk.start.mockRejectedValueOnce(new Error('private-start-error'));
  const failed = createSlackSession({ ...config, historyPath }, () => {});
  await expect(failed.start()).rejects.toThrow('private-start-error'); await failed.stop();
  const reopened = await openSqliteHistory(historyPath); expect((await reopened.get(key, signal))[1]!.content).toBe('**canonical**'); await reopened.close();
  const session = createSlackSession({ ...config, historyPath }, () => {}); await session.start(); await session.shutdown(); await session.stop();
  const after = await openSqliteHistory(historyPath); expect(await after.get(key, signal)).toHaveLength(2); await after.close();
});
it('corrupt configured history prevents Slack startup and outputs only static history-unavailable', async () => {
  const historyPath = path(); writeFileSync(historyPath, 'private corrupted content', { mode: 0o600 });
  const error = new PassThrough(); let text = ''; error.on('data', chunk => { text += String(chunk); });
  const result = await runSlack({ args: [], output: new PassThrough(), error, signal: new AbortController().signal,
    env: { DEEPSEEK_API_KEY: config.deepseekApiKey, SLACK_BOT_TOKEN: config.botToken, SLACK_APP_TOKEN: config.appToken, SLACK_HISTORY_DB: historyPath } });
  expect(result).toBe(1); expect(sdk.start).not.toHaveBeenCalled();
  expect(text).toContain(HISTORY_ERROR_TEXT); expect(text).not.toContain(historyPath); expect(text).not.toContain('private corrupted content');
});
