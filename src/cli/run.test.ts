import { Readable, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli, parseArgs, type CliOptions } from './run.js';
import { CHAT_LIMITS, trimHistory, type ChatMessage } from '../chat.js';

async function run(overrides: Partial<CliOptions> = {}) {
  let out = '', err = '';
  const output = new PassThrough();
  const error = new PassThrough();
  output.on('data', (chunk) => { out += String(chunk); });
  error.on('data', (chunk) => { err += String(chunk); });
  const code = await runCli({
    args: [], env: { DEEPSEEK_API_KEY: 'synthetic' },
    input: Readable.from([]), output, error,
    chatFactory: () => async () => 'offline reply', ...overrides,
  });
  return { code, out, err };
}

describe('local CLI, offline and secret-safe', () => {
  it('shows help without loading config or constructing a model', async () => {
    const chatFactory = vi.fn();
    const result = await run({ args: ['--help'], env: {}, chatFactory });
    expect(result.code).toBe(0); expect(result.out).toContain('--prompt');
    expect(chatFactory).not.toHaveBeenCalled();
  });
  it.each([['--bad'], ['--prompt'], ['-p', ''], ['-p', 'x'.repeat(CHAT_LIMITS.promptChars + 1)], ['--help', 'extra']])('rejects invalid arguments %j', async (...args) => {
    expect(() => parseArgs(args)).toThrow();
    expect((await run({ args })).code).toBe(2);
  });
  it('validates environment before calling a model', async () => {
    const chatFactory = vi.fn();
    const result = await run({ env: {}, args: ['-p', 'hello'], chatFactory });
    expect(result.code).toBe(1); expect(result.err).toContain('DEEPSEEK_API_KEY');
    expect(chatFactory).not.toHaveBeenCalled();
  });
  it('one-shot mode prints just the response', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[], _signal: AbortSignal) => 'one-shot');
    const result = await run({ args: ['--prompt', ' hello '], chatFactory: () => chat });
    expect(result).toEqual({ code: 0, out: 'one-shot\n', err: '' });
    expect(chat.mock.calls[0]?.[0]).toEqual([{ role: 'user', content: 'hello' }]);
  });
  it('interactive history exists only in process memory, clear/exit/EOF work', async () => {
    const captured: ChatMessage[][] = [];
    const result = await run({
      input: Readable.from(['first\n\nsecond\n/clear\nthird\n/exit\nignored\n']), interactive: true,
      chatFactory: () => async (messages) => { captured.push(messages); return 'reply'; },
    });
    expect(result.code).toBe(0); expect(result.out).toContain('> ');
    expect(captured).toHaveLength(3);
    expect(captured[1]).toEqual([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'second' }]);
    expect(captured[2]).toEqual([{ role: 'user', content: 'third' }]);
  });
  it('does not echo provider exceptions or secret values and does not save failed turns', async () => {
    const captured: ChatMessage[][] = [];
    const result = await run({ input: Readable.from(['first\nsecond\n']), chatFactory: () => async (messages) => {
      captured.push(messages);
      if (captured.length === 1) throw new Error('synthetic secret provider body');
      return 'reply';
    } });
    expect(result.code).toBe(1); expect(result.err).not.toMatch(/synthetic|secret|provider body/u);
    expect(captured[1]).toEqual([{ role: 'user', content: 'second' }]);
  });
  it('bounds prompt/reply and strips terminal control characters', async () => {
    const chat = vi.fn(async () => '\u001b]52;c;payload\u0007' + 'x'.repeat(CHAT_LIMITS.replyChars));
    const result = await run({ args: ['-p', 'q'], chatFactory: () => chat });
    expect(result.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    expect(result.out).toContain('잘림');
    expect((await run({ input: Readable.from(['x'.repeat(CHAT_LIMITS.promptChars + 1) + '\n']), chatFactory: () => chat })).code).toBe(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it('times out even non-cooperative injected model calls', async () => {
    // A referenced handle keeps Node alive while AbortSignal.timeout's timer is unref'ed.
    const handle = setInterval(() => {}, 50);
    try {
      const result = await run({ args: ['-p', 'q'], deadlineMs: 10, chatFactory: () => () => new Promise(() => {}) });
      expect(result.code).toBe(1); expect(result.err).toContain('시간 제한');
    } finally { clearInterval(handle); }
  });
  it('cancels in-flight chat with exit code 130', async () => {
    const controller = new AbortController();
    const result = await run({ args: ['-p', 'q'], signal: controller.signal, chatFactory: () => () => {
      controller.abort(); return new Promise(() => {});
    } });
    expect(result.code).toBe(130); expect(result.err).toBe('');
  });
  it('cancels while waiting for interactive input', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      const result = await run({ input, signal: controller.signal });
      expect(result.code).toBe(130);
    } finally { clearTimeout(timer); input.destroy(); }
  });
  it('redacts initialization exceptions as well as model failures', async () => {
    const result = await run({ chatFactory: () => { throw new Error('synthetic secret'); } });
    expect(result.code).toBe(1); expect(result.err).toContain('초기화');
    expect(result.err).not.toMatch(/synthetic|secret/u);
  });
  it('handles already-aborted input and empty responses', async () => {
    expect((await run({ signal: AbortSignal.abort() })).code).toBe(130);
    expect((await run({ args: ['-p', 'q'], chatFactory: () => async () => ' ' })).code).toBe(1);
  });
  it('bounds history by both turns and characters', () => {
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index).padEnd(8_000, 'x') }));
    const history = trimHistory(messages);
    expect(history.length).toBeLessThanOrEqual(CHAT_LIMITS.turns * 2);
    expect(history.reduce((size, item) => size + item.content.length, 0)).toBeLessThanOrEqual(CHAT_LIMITS.historyChars);
    expect(history[0]?.role).toBe('user'); expect(history.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(messages).toHaveLength(40);
  });
});
