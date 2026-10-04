import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { reportHealth } from './health.js';
import type { Writable } from 'node:stream';
import { ConfigError } from '../config.js';
import { loadSlackConfig, type SlackConfig } from './config.js';
import { registerSlackHandlers, type SafeLog } from './handlers.js';
import { createSlackModels } from './model.js';
import { abortable, SLACK_LIMITS } from './limits.js';

export const SLACK_HELP = `my-mastra — Slack Socket Mode 봇\n\n사용법:\n  npm run start:slack\n  npm run dev:slack\n  npm run start:slack -- --help\n\n필수: DEEPSEEK_API_KEY, SLACK_BOT_TOKEN(xoxb-), SLACK_APP_TOKEN(xapp-).\n선택: DEEPSEEK_MODEL, EXA_API_KEY. CLI에는 Slack 키가 필요하지 않습니다.\n설치/권한/개인정보/운영 한계: docs/slack.md 및 docs/slack-manifest.json 참고.\n`;
export interface SlackSession { start: () => Promise<unknown>; stop: () => Promise<unknown>; shutdown: () => void; ready?: () => boolean }
export function createSlackSession(config: SlackConfig, log: SafeLog): SlackSession {
  // Bolt/Web API logs may otherwise include request/response data or arbitrary Error objects.
  const logger = {
    debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => log('transport_error'),
    setLevel: (_level: LogLevel) => {}, getLevel: () => LogLevel.ERROR, setName: (_name: string) => {},
  };
  const clientOptions = { timeout: SLACK_LIMITS.apiTimeoutMs, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true };
  // Bolt forwards this public option to SocketModeClient too. No OAuth credentials/routes are set,
  // so installerOptions here does not create an installer or HTTP server.
  const receiver = new SocketModeReceiver({ appToken: config.appToken, logger, logLevel: LogLevel.ERROR,
    installerOptions: { clientOptions } });
  let connected = false;
  let started = false;
  // SDK 'connected' follows Slack's hello frame; close/reconnect immediately clears readiness.
  receiver.client.on('connected', () => { connected = true; });
  for (const event of ['close', 'disconnected', 'disconnecting', 'reconnecting']) {
    receiver.client.on(event, () => { connected = false; });
  }
  const app = new App({ token: config.botToken, receiver,
    logger, logLevel: LogLevel.ERROR,
    clientOptions,
  });
  const handlers = registerSlackHandlers(app, { client: app.client, ...createSlackModels(config),
    secrets: [config.botToken, config.appToken, config.deepseekApiKey, config.exaApiKey ?? ''], log });
  app.error(async () => log('transport_error'));
  return {
    start: async () => { const result = await app.start(); started = true; return result; },
    ready: () => started && connected && receiver.client.websocket?.isActive() === true,
    stop: () => { started = false; connected = false; return app.stop(); },
    shutdown: handlers.shutdown,
  };
}

export async function runSlack(options: {
  args: string[]; output: Writable; error: Writable; signal: AbortSignal; env?: NodeJS.ProcessEnv;
  sessionFactory?: (config: SlackConfig, log: SafeLog) => SlackSession;
}): Promise<number> {
  if (options.args.length === 1 && ['--help', '-h'].includes(options.args[0]!)) { options.output.write(SLACK_HELP); return 0; }
  if (options.args.length) { options.error.write('Slack 실행 인자를 확인하세요. --help를 참고하세요.\n'); return 2; }
  const log: SafeLog = code => options.error.write(`Slack ${code}\n`);
  let session: SlackSession | undefined;
  let abort = () => {};
  let stopHealth = () => {};
  try {
    const config = loadSlackConfig(options.env);
    if (options.signal.aborted) return 130;
    session = (options.sessionFactory ?? createSlackSession)(config, log);
    let startupComplete = false;
    stopHealth = reportHealth((options.env ?? process.env).SLACK_HEALTH_FILE,
      () => startupComplete && !options.signal.aborted && session?.ready?.() === true,
      () => log('transport_error'));
    abort = () => session?.shutdown();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    await abortable(session.start(), AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]));
    startupComplete = true;
    log('started');
    await new Promise<void>(resolve => {
      const done = () => { options.signal.removeEventListener('abort', done); resolve(); };
      options.signal.addEventListener('abort', done, { once: true });
      if (options.signal.aborted) done();
    });
    return 130;
  } catch (error) {
    if (error instanceof ConfigError) options.error.write(error.message + '\n');
    else if (!options.signal.aborted) log('startup_failed');
    return options.signal.aborted ? 130 : 1;
  } finally {
    stopHealth();
    options.signal.removeEventListener('abort', abort);
    session?.shutdown();
    if (session) {
      try { await abortable(session.stop(), AbortSignal.timeout(5_000)); } catch { log('transport_error'); }
      log('stopped');
    }
  }
}
