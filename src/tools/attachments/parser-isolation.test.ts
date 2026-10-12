import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
import { parseAttachment } from './parser.js';
import { ATTACHMENT_LIMITS as L } from './policy.js';
it('kills a hung parser off-loop at wall limit, limits concurrency and strips credentials/NODE_OPTIONS', async () => {
  vi.useFakeTimers();
  const children: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> })[] = [];
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    children.push(child); return child;
  });
  try {
    const one = parseAttachment(Buffer.from('x'), 'text');
    const two = parseAttachment(Buffer.from('x'), 'pdf');
    const checkOne = expect(one).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    const checkTwo = expect(two).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    await expect(parseAttachment(Buffer.from('x'), 'csv')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    const [exec, args, opts] = mock.spawn.mock.calls[0]!;
    expect(exec).toBe(process.execPath);
    expect(args).toContain(`--max-old-space-size=${L.parserHeapMb}`);
    expect(Object.keys(opts.env).sort()).toEqual(['LANG', 'PATH']);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    await vi.advanceTimersByTimeAsync(L.parserMs + 1);
    expect(children.every(child => child.kill.mock.calls.some(([signal]) => signal === 'SIGKILL'))).toBe(true);
    // SIGKILL intent is not child settlement: keep the parser slots until actual close.
    await expect(parseAttachment(Buffer.from('x'), 'csv')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    children.forEach(child => child.emit('close', null, 'SIGKILL'));
    await checkOne; await checkTwo;
  } finally { vi.useRealTimers(); }
});
