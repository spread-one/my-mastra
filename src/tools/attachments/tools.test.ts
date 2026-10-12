import { describe, expect, it, vi } from 'vitest';
import { readAttachment, createAttachmentTools } from './tools.js';
import { AttachmentError, ATTACHMENT_LIMITS as L } from './policy.js';
import { fakeNetwork } from './network.test-helper.js';
import { pdfFixture } from './fixtures.test-helper.js';
const input = { fileId: 'F123', messageTs: '123.000001' };
function options(body: Buffer, mime = 'text/plain') {
  return { botToken: 'synthetic-token', downloadDependencies: fakeNetwork([{ body, headers: { 'content-type': mime } }]),
    authorize: vi.fn(async (fileId: string, messageTs: string) => ({ channelId: 'C123', messageTs,
      file: { id: fileId, name: '비신뢰 이름 😀', mimetype: mime, size: body.length,
        url_private_download: 'https://files.slack.com/files-pri/T1-F123/file' } })) };
}
describe('attachment tool capability contract and bounded citations', () => {
  it('uses trusted authorization before reading; current-channel provenance is not model-controlled', async () => {
    const opts = options(Buffer.from('a\n한글 😀\nc'));
    const result = await readAttachment({ ...input, unitStart: 2, unitCount: 1 }, opts);
    expect(opts.authorize).toHaveBeenCalledWith(input.fileId, input.messageTs, undefined, undefined, undefined);
    expect(result).toMatchObject({ ok: true, source: { fileId: 'F123', channelId: 'C123', messageTs: input.messageTs },
      units: [{ unit: 2, start: 2, end: 2, text: '한글 😀' }], nextUnit: 3, complete: false, truncated: false });
  });
  it('never downloads arbitrary inaccessible file IDs or other-channel messages denied by bridge', async () => {
    for (const code of ['ACCESS_DENIED', 'MISSING_SCOPE'] as const) {
      const opts = options(Buffer.from('secret'));
      opts.authorize.mockRejectedValue(new AttachmentError(code));
      expect(await readAttachment(input, opts)).toMatchObject({ ok: false, error: { code } });
      expect(opts.downloadDependencies.requests).toHaveLength(0);
    }
  });
  it('rejects mismatched capability metadata, oversize, unsupported MIME and MIME/signature mismatch', async () => {
    const opts = options(Buffer.from('secret'));
    opts.authorize.mockResolvedValue({ channelId: 'C123', messageTs: input.messageTs,
      file: { id: 'FOTHER', name: 'bad', mimetype: 'text/plain', size: 6, url_private_download: 'https://evil.test' } });
    expect(await readAttachment(input, opts)).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
    expect(opts.downloadDependencies.requests).toHaveLength(0);
    const oversize = options(Buffer.from('small'));
    oversize.authorize.mockResolvedValue({ channelId: 'C123', messageTs: input.messageTs,
      file: { id: 'F123', name: 'large.txt', mimetype: 'text/plain', size: L.fileBytes + 1, url_private_download: 'https://files.slack.com/files-pri/T1-F123/file' } });
    expect(await readAttachment(input, oversize)).toMatchObject({ ok: false, error: { code: 'FILE_LIMIT' } });
    expect(oversize.downloadDependencies.requests).toHaveLength(0);
    expect(await readAttachment(input, options(Buffer.from('PK\x03\x04')))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_TYPE' } });
    expect(await readAttachment(input, options(Buffer.from('word'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_TYPE' } });
    expect(await readAttachment(input, options(Buffer.from('ascii'), 'text/plain; charset=iso-8859-1'))).toMatchObject({ ok: false, error: { code: 'INVALID_UTF8' } });
    const mismatch = options(Buffer.from('hello'));
    mismatch.downloadDependencies = fakeNetwork([{ body: Buffer.from('hello'), headers: { 'content-type': 'application/pdf' } }]);
    expect(await readAttachment(input, mismatch)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_TYPE' } });
  });
  it('returns literal query matches with original line/page provenance', async () => {
    const result = await readAttachment({ ...input, query: '한글' }, options(Buffer.from('a\n한글\nb\n한글 😀')));
    expect(result).toMatchObject({ ok: true, totalMatches: 2, units: [{ start: 2 }, { start: 4 }], complete: false });
    const pdf = await readAttachment({ ...input, unitStart: 2 }, options(pdfFixture(['first', 'second']), 'application/pdf'));
    expect(pdf).toMatchObject({ ok: false, error: { code: 'PDF_UNAVAILABLE' } });
  });
  it('UTF8 output bytes stay bounded and clipping is explicit without skipping a partial unit', async () => {
    const result = await readAttachment(input, options(Buffer.from('😀'.repeat(30000))));
    expect(result).toMatchObject({ ok: true, truncated: true, complete: false, nextUnit: 1, units: [{ truncated: true }] });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(L.outputBytes);
    if (result.ok) expect(result.units[0]!.text).not.toContain('\ufffd');
    const csv = await readAttachment(input, options(Buffer.from(Array(10).fill('x'.repeat(15000)).join(',')), 'text/csv'));
    expect(csv).toMatchObject({ ok: true, truncated: true, units: [{ truncated: true }] });
    expect(Buffer.byteLength(JSON.stringify(csv))).toBeLessThanOrEqual(L.outputBytes);
  });
  it('provides actual Mastra tool with fixed file/message schema and no URL/channel/user parameter', async () => {
    const opts = options(Buffer.from('hello')); const tools = createAttachmentTools(opts);
    expect(Object.keys(tools)).toEqual(['slack_read_attachment']);
    expect(tools.slack_read_attachment!.id).toBe('slack_read_attachment');
    const result = await tools.slack_read_attachment!.execute!(input, {} as never);
    expect(result).toMatchObject({ ok: true, complete: true, units: [{ text: 'hello' }] });
  });
});
