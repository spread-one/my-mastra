import { once } from 'node:events';
import http from 'node:http';
import type https from 'node:https';
import type { lookup } from 'node:dns/promises';
import { expect, it, vi } from 'vitest';
import { downloadAttachment, type DownloadDependencies } from './download.js';
import { ATTACHMENT_LIMITS as L } from './policy.js';

it.each(['headers', 'body', 'deadline'] as const)('aborts a real synthetic download socket during %s wait', async phase => {
  let received!: () => void; const arrived = new Promise<void>(resolve => { received = resolve; });
  let closed!: () => void; const gone = new Promise<void>(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    req.socket.once('close', closed); req.resume();
    req.once('end', () => {
      if (phase === 'body') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); }
      received();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const dependencies: DownloadDependencies = {
    resolve: (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup,
    // Synthetic routing only: production uses HTTPS/pinned public DNS.
    request: ((_url: URL, options: https.RequestOptions, callback: Function) => http.request({
      ...options, host: '127.0.0.1', port, path: '/synthetic', lookup: undefined,
    }, callback as never)) as unknown as typeof https.request,
  };
  const controller = new AbortController();
  try {
    if (phase === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = downloadAttachment('https://files.slack.com/files-pri/T-F/test', 'synthetic-token', { ...dependencies, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await arrived;
    if (phase === 'deadline') await vi.advanceTimersByTimeAsync(L.downloadMs); else controller.abort();
    await assertion; await gone;
  } finally {
    vi.useRealTimers(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
