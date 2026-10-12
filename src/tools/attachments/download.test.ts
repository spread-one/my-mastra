import { fakeNetwork } from './network.test-helper.js';
import { describe, expect, it, vi } from 'vitest';
import type { lookup } from 'node:dns/promises';
import { downloadAttachment, publicAddress, slackDownloadUrl } from './download.js';
import { ATTACHMENT_LIMITS as L } from './policy.js';
const url = 'https://files.slack.com/files-pri/T1-F1/name.txt';
describe('independent authenticated Slack downloader', () => {
  it('pins public DNS and sends only the existing token to exact allowed Slack origin', async () => {
    const net = fakeNetwork([{}]); const result = await downloadAttachment(url, 'synthetic-token', net);
    expect(result.body.toString()).toBe('hello');
    const options = net.requests[0]!.options;
    expect(options.headers).toMatchObject({ Authorization: 'Bearer synthetic-token', 'Accept-Encoding': 'identity' });
    const cb = vi.fn(); (options.lookup as Function)('files.slack.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.agent).toBe(false);
  });
  it('never leaks token via off-origin redirects (even Slack subdomains/CDNs)', async () => {
    for (const target of ['https://evil.example/file', 'http://files.slack.com/files-pri/x',
      'https://slack.com/files-pri/x', 'https://files.slack.com.evil.test/files-pri/x', 'https://127.0.0.1/a']) {
      const net = fakeNetwork([{ status: 302, headers: { location: target } }]);
      await expect(downloadAttachment(url, 'synthetic-token', net)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
      expect(net.requests).toHaveLength(1);
    }
  });
  it('allows bounded same-origin private-path redirects and rechecks DNS', async () => {
    const net = fakeNetwork([{ status: 302, headers: { location: '/files-pri/T1-F1/new.txt' } }, {}]);
    await downloadAttachment(url, 'synthetic-token', net);
    expect(net.requests).toHaveLength(2); expect(net.resolve).toHaveBeenCalledTimes(2);
    const loop = fakeNetwork(Array(3).fill({ status: 302, headers: { location: url } }));
    await expect(downloadAttachment(url, 'synthetic-token', loop)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(loop.requests).toHaveLength(3);
  });
  it('rejects arbitrary URL/port/userinfo/path and private/mixed DNS before requesting', async () => {
    for (const target of ['https://files.slack.com:444/files-pri/a', 'https://user@files.slack.com/files-pri/a',
      'https://files.slack.com/api/x', 'file:///a', 'https://files.slack.com/files-pri/a#x'])
      expect(() => slackDownloadUrl(target)).toThrow();
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '224.0.0.1']) {
      expect(publicAddress(address)).toBe(false);
      const net = fakeNetwork([]);
      net.resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]) as unknown as typeof lookup;
      await expect(downloadAttachment(url, 'synthetic-token', net)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
      expect(net.requests).toHaveLength(0);
    }
  });
  it('bounds streaming bodies, declared size and compressed HTTP responses', async () => {
    for (const reply of [{ body: Buffer.alloc(L.fileBytes + 1) },
      { headers: { 'content-length': String(L.fileBytes + 1) } }])
      await expect(downloadAttachment(url, 'synthetic-token', fakeNetwork([reply]))).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    await expect(downloadAttachment(url, 'synthetic-token', fakeNetwork([{ headers: { 'content-encoding': 'gzip' } }]))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
  it('deadline also bounds hung DNS resolution without issuing a request', async () => {
    vi.useFakeTimers();
    try {
      const net = fakeNetwork([]); net.resolve = (() => new Promise(() => {})) as unknown as typeof lookup;
      const result = downloadAttachment(url, 'synthetic-token', net);
      const check = expect(result).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
      await vi.advanceTimersByTimeAsync(L.downloadMs + 1); await check;
      expect(net.requests).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
