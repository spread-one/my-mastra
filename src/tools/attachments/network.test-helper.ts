import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type https from 'node:https';
import type { lookup } from 'node:dns/promises';
export function fakeNetwork(responses: { status?: number; headers?: Record<string, string>; body?: Buffer }[]) {
  const requests: { url: URL; options: https.RequestOptions }[] = [];
  const request = vi.fn((url: URL, options: https.RequestOptions, callback: (r: unknown) => void) => {
    requests.push({ url, options }); const next = responses.shift()!;
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const response = Readable.from([next.body ?? Buffer.from('hello')]);
      Object.assign(response, { statusCode: next.status ?? 200, headers: next.headers ?? { 'content-type': 'text/plain' } });
      response.once('close', () => req.emit('close'));
      queueMicrotask(() => callback(response));
    };
    return req;
  }) as unknown as typeof https.request;
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup;
  return { request, resolve, requests };
}
