import { describe, expect, it, vi } from 'vitest';
import { readAttachment } from './tools.js';
import { readImage } from '../images/tools.js';
import { validateFileMetadata, type AttachmentMetadata } from './policy.js';
import { fakeNetwork } from './network.test-helper.js';
import { slackDownloadUrl } from './download.js';
import { pngFixture } from '../images/fixtures.test-helper.js';
const input = { fileId: 'F123', messageTs: '123.000001' };
const url = 'https://files.slack.com/files-pri/T-F/test';
const file: AttachmentMetadata = { id: input.fileId, name: 'test', mimetype: 'text/plain', size: 5, url_private_download: url };
describe('foundation security contract', () => {
  it('allows TXT/CSV snippets only and denies external/unknown modes even with injected capabilities', () => {
    for (const mime of ['text/plain', 'text/markdown', 'text/csv']) expect(() => validateFileMetadata({ ...file, mode: 'snippet', mimetype: mime })).not.toThrow();
    for (const mime of ['image/png', 'image/jpeg', 'application/pdf', 'text/html', 'text/plain; charset=', 'text/plain; charset=utf8; charset=latin1']) expect(() => validateFileMetadata({ ...file, mode: 'snippet', mimetype: mime })).toThrow();
    for (const metadata of [{ is_external: true }, { mode: 'external' }, { mode: 'post' }]) expect(() => validateFileMetadata({ ...file, ...metadata })).toThrow('ACCESS_DENIED');
  });
  it('preserves request signal and exact file/channel/message linkage; invalid ranges never authorize', async () => {
    const controller = new AbortController(); const context = {};
    const authorize = vi.fn(async () => ({ file, channelId: 'C123', messageTs: input.messageTs }));
    const network = fakeNetwork([{ body: Buffer.from('hello'), headers: { 'content-type': 'application/force-download; charset=UTF-8' } }]);
    const options = { authorize, botToken: 'test-secret', downloadDependencies: network };
    expect(await readAttachment(input, options, context, controller.signal)).toMatchObject({ ok: true });
    expect(authorize).toHaveBeenCalledWith(input.fileId, input.messageTs, context, undefined, controller.signal);
    authorize.mockClear();
    for (const range of [{ unitStart: 0 }, { unitCount: 201 }, { unitStart: 1.5 }, { unitStart: 100001 }]) expect((await readAttachment({ ...input, ...range }, options)).ok).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    controller.abort(); expect((await readAttachment(input, options, context, controller.signal)).ok).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });
  it('fails safe without separate vision configuration before authorization or download', async () => {
    const authorize = vi.fn(async () => ({ file: { ...file, mimetype: 'image/png', size: pngFixture().length }, channelId: 'C123', messageTs: input.messageTs }));
    expect(await readImage(input, { authorize, botToken: 'test-secret' })).toMatchObject({ error: { code: 'VISION_CONFIG' } });
    expect(authorize).not.toHaveBeenCalled();
  });
  it('rejects encoded traversal/control/path ambiguity and prevents reflected credentials/URL output', async () => {
    for (const suffix of ['%2e%2e/foo', 'x%2fy', 'x%5cy', 'x%00', '%zz']) expect(() => slackDownloadUrl(url + '/' + suffix)).toThrow('UNSAFE_URL');
    for (const text of ['test-secret', url]) {
      const network = fakeNetwork([{ body: Buffer.from(text), headers: { 'content-type': 'text/plain' } }]);
      const authorize = async () => ({ file: { ...file, size: Buffer.byteLength(text) }, channelId: 'C123', messageTs: input.messageTs });
      const result = await readAttachment(input, { authorize, botToken: 'test-secret', downloadDependencies: network });
      expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain(text);
    }
  });
});
