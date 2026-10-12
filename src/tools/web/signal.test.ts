import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createWebTools } from './tools.js';
import { ContentStore } from './content.js';
import { RequestContext } from '@mastra/core/request-context';

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
describe('SDK abortSignal forwarding without cancellation UI', () => {
  it.each(['web_fetch', 'web_search'])('rejects pre-aborted %s without a network operation', async (name) => {
    const connector = vi.fn();
    const abortSignal = AbortSignal.abort();
    const tools = createWebTools({ network: { resolver, connector } });
    const input = name === 'web_fetch' ? { url: 'https://source.org' } : { query: 'hello' };
    const result = await tools[name]!.execute!(input as never, { abortSignal } as never);
    expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(connector).not.toHaveBeenCalled();
  });
  it('forwards abort during body reading and never admits a partial snapshot', async () => {
    const controller = new AbortController();
    const store = new ContentStore(); const put = vi.spyOn(store, 'put');
    const stream = new PassThrough() as unknown as IncomingMessage;
    stream.statusCode = 200; stream.headers = { 'content-type': 'text/plain' };
    const connector = vi.fn(async (_url, _address, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      setTimeout(() => controller.abort(), 10);
      return stream;
    });
    const tools = createWebTools({ contentStore: store, network: { resolver, connector } });
    const requestContext = new RequestContext<unknown>(Object.entries({ teamId: 'T', userId: 'U', channel: 'C', threadTs: '1.1' }));
    expect(await tools.web_fetch!.execute!({ url: 'https://source.org' } as never, { requestContext, abortSignal: controller.signal } as never)).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(stream.destroyed).toBe(true); expect(put).not.toHaveBeenCalled();
  });
});
