import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, healthReady, reportHealth } from './health.js';

const sdk = vi.hoisted(() => ({ receiverOptions: [] as unknown[], receivers: [] as { client: EventEmitter & { websocket: { isActive: () => boolean } } }[],
  start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock('@slack/bolt', () => ({
  LogLevel: { ERROR: 'error' },
  SocketModeReceiver: class {
    client = Object.assign(new EventEmitter(), { websocket: { isActive: () => true } });
    constructor(options: unknown) { sdk.receiverOptions.push(options); sdk.receivers.push(this); }
  },
  App: class { client = {}; start = sdk.start; stop = sdk.stop; error() {} },
}));
vi.mock('./handlers.js', () => ({ registerSlackHandlers: () => ({ shutdown: () => {} }) }));
vi.mock('./model.js', () => ({ createSlackModels: () => ({}) }));
import { createSlackSession, runSlack } from './run.js';
const config = { deepseekApiKey: 'synthetic', model: 'deepseek-chat', botToken: 'xoxb-synthetic', appToken: 'xapp-synthetic' };
const directories: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'slack-health-')); directories.push(dir); return join(dir, 'health.json'); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sdk.receivers.length = 0; sdk.receiverOptions.length = 0; sdk.start.mockReset().mockResolvedValue(undefined); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true }); });

describe('file health uses completed Slack start and live SDK hello/socket state', () => {
  it('rejects missing, stale, future, false, malformed and process-only health', () => {
    const path = fixture(); expect(checkHealth(path)).toBe(false);
    for (const value of [null, {}, { ready: false, time: 100 }, { ready: true, time: 101 }, { ready: true, time: -10_000 }, { ready: true, time: '100' }]) expect(healthReady(value, 100)).toBe(false);
    expect(healthReady({ ready: true, time: 100 }, 100)).toBe(true);
    writeFileSync(path, 'invalid'); expect(checkHealth(path)).toBe(false);
  });
  it('writes only static status/time, transitions and removes health on shutdown', () => {
    vi.useFakeTimers(); const path = fixture(); let ready = false;
    const failed = vi.fn(); const stop = reportHealth(path, () => ready, failed);
    expect(checkHealth(path)).toBe(false); ready = true; vi.advanceTimersByTime(2_000);
    expect(checkHealth(path)).toBe(true); expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['ready', 'time']);
    ready = false; vi.advanceTimersByTime(2_000); expect(checkHealth(path)).toBe(false);
    stop(); expect(existsSync(path)).toBe(false); expect(failed).not.toHaveBeenCalled();
    const failure = reportHealth('/nonexistent-directory/health', () => true, failed); failure(); expect(failed).toHaveBeenCalled();
  });
  it('never accepts WebSocket OPEN alone or hello before startup completion; clears on reconnect/close', async () => {
    let resolve!: () => void; sdk.start.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
    const session = createSlackSession(config, () => {}); const client = sdk.receivers[0]!.client;
    expect(sdk.receiverOptions[0]).toMatchObject({ installerOptions: { clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true } } });
    expect(sdk.receiverOptions[0]).not.toHaveProperty('clientId');
    expect(session.ready!()).toBe(false); const start = session.start(); client.emit('connected');
    expect(session.ready!()).toBe(false); resolve(); await start; expect(session.ready!()).toBe(true);
    client.websocket.isActive = () => false; expect(session.ready!()).toBe(false);
    client.websocket.isActive = () => true;
    for (const event of ['close', 'disconnected', 'disconnecting', 'reconnecting']) {
      client.emit(event); expect(session.ready!()).toBe(false); client.emit('connected'); expect(session.ready!()).toBe(true);
    }
    await session.stop(); expect(session.ready!()).toBe(false);
  });
  it('fails closed for sessions without a readiness implementation and cleans failed startup', async () => {
    vi.useFakeTimers(); const path = fixture(), controller = new AbortController(), stream = new PassThrough();
    const env = { DEEPSEEK_API_KEY: config.deepseekApiKey, SLACK_BOT_TOKEN: config.botToken, SLACK_APP_TOKEN: config.appToken, SLACK_HEALTH_FILE: path };
    const run = runSlack({ args: [], env, signal: controller.signal, output: stream, error: stream,
      sessionFactory: () => ({ start: async () => {}, stop: async () => {}, shutdown: () => {} }) });
    await vi.advanceTimersByTimeAsync(2_000); expect(checkHealth(path)).toBe(false);
    controller.abort(); expect(await run).toBe(130); expect(existsSync(path)).toBe(false);
    const failed = await runSlack({ args: [], env, signal: new AbortController().signal, output: stream, error: stream,
      sessionFactory: () => ({ start: async () => { throw new Error('synthetic-private'); }, stop: async () => {}, shutdown: () => {}, ready: () => true }) });
    expect(failed).toBe(1); expect(existsSync(path)).toBe(false); expect(existsSync(path + '.tmp')).toBe(false);
  });
  it('runSlack publishes false until start resolves and cleans on abort', async () => {
    vi.useFakeTimers(); const path = fixture(), controller = new AbortController();
    let resolve!: () => void; let ready = false;
    const stream = new PassThrough(); let logs = ''; stream.on('data', data => { logs += String(data); });
    const run = runSlack({ args: [], signal: controller.signal, output: stream, error: stream,
      env: { DEEPSEEK_API_KEY: config.deepseekApiKey, SLACK_BOT_TOKEN: config.botToken, SLACK_APP_TOKEN: config.appToken, SLACK_HEALTH_FILE: path },
      sessionFactory: () => ({ start: () => new Promise<void>(yes => { resolve = yes; }), stop: async () => {}, shutdown: () => {}, ready: () => ready }) });
    ready = true; vi.advanceTimersByTime(2_000); expect(checkHealth(path)).toBe(false);
    resolve(); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(2_000); expect(checkHealth(path)).toBe(true);
    ready = false; vi.advanceTimersByTime(2_000); expect(checkHealth(path)).toBe(false);
    controller.abort(); expect(await run).toBe(130); expect(existsSync(path)).toBe(false);
    expect(logs).not.toContain('synthetic'); expect(logs).toContain('stopped');
  });
});
