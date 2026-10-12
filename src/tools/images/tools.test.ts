import { describe, expect, it, vi } from 'vitest';
import { AttachmentError } from '../attachments/policy.js';
import { fakeNetwork } from '../attachments/network.test-helper.js';
import { pngFixture, jpegFixture, visionResponse } from './fixtures.test-helper.js';
import { IMAGE_LIMITS as L } from './policy.js';
import { createImageTools, imageInput, readImage, type ImageToolOptions } from './tools.js';

const args = { fileId: 'F123', messageTs: '123.000002', threadTs: '123.000001', question: '스크린샷 글자와 도표를 읽어 주세요.' };
const context = {};
function fixture(bytes = pngFixture(), mime = 'image/png') {
  const file = { id: args.fileId, name: 'private-name-do-not-send-to-model', mimetype: mime, size: bytes.length,
    url_private_download: 'https://files.slack.com/files-pri/T123-F123/private.png' };
  const authorize = vi.fn(async (_fileId: string, _messageTs: string, ctx?: object) => {
    if (ctx !== context) throw new AttachmentError('ACCESS_DENIED');
    return { file, channelId: 'C123', messageTs: args.messageTs };
  });
  const download = fakeNetwork([{ body: bytes, headers: { 'content-type': mime } }]);
  const transport = fakeNetwork([{ body: Buffer.from(visionResponse()), headers: { 'content-type': 'application/json' } }]);
  const options: ImageToolOptions = { authorize, botToken: 'xoxb-test-bot-secret',
    vision: { apiKey: 'test-llm-secret', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' },
    downloadDependencies: download, visionDependencies: transport };
  return { file, options, authorize, download, transport };
}
describe('independent Slack image tool using predecessor capabilities', () => {
  it('returns bounded derived evidence, source and explicit uncertainty limits, not original OCR or secrets', async () => {
    for (const [bytes, mime] of [[pngFixture(), 'image/png'], [jpegFixture(), 'image/jpeg']] as const) {
      const f = fixture(bytes, mime); const result = await readImage(args, f.options, context);
      expect(result).toMatchObject({ ok: true, evidence: 'derived_image_interpretation',
        source: { fileId: args.fileId, channelId: 'C123', messageTs: args.messageTs, threadTs: args.threadTs },
        image: { mime, width: 1, height: 1 }, truncated: false });
      if (!result.ok) throw new Error('unexpected failure');
      expect(result.notice).toContain('정확성을 보장하지 않습니다'); expect(result.notice).toContain('승인이 아닙니다');
      expect(result.interpretation).toContain('확실하지 않습니다');
      expect(f.authorize).toHaveBeenCalledExactlyOnceWith(args.fileId, args.messageTs, context, args.threadTs, undefined);
      expect(f.download.requests[0]!.options.headers).toMatchObject({ Authorization: `Bearer ${f.options.botToken}` });
      expect(f.transport.requests[0]!.options.headers).toMatchObject({ Authorization: `Bearer ${f.options.vision!.apiKey}` });
      for (const secret of [f.file.name, f.file.url_private_download, f.options.botToken, f.options.vision!.apiKey, bytes.toString('base64')])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(L.outputBytes + 4096);
    }
  });
  it('does not authorize arbitrary file IDs, foreign context or mismatched exact-message/file capability', async () => {
    const foreign = fixture();
    const forged = { get: () => ({ userId: 'U123', channel: 'C123' }) };
    expect(await readImage(args, foreign.options, forged)).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
    expect(foreign.download.request).not.toHaveBeenCalled(); expect(foreign.transport.request).not.toHaveBeenCalled();
    for (const mismatch of [{ file: { ...foreign.file, id: 'FOTHER' }, channelId: 'C123', messageTs: args.messageTs },
      { file: foreign.file, channelId: 'C123', messageTs: '123.000001' }, { file: foreign.file, channelId: '', messageTs: args.messageTs }]) {
      const f = fixture(); f.authorize.mockResolvedValue(mismatch);
      expect(await readImage(args, f.options, context)).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
      expect(f.download.request).not.toHaveBeenCalled(); expect(f.transport.request).not.toHaveBeenCalled();
    }
  });
  it('keeps authorization errors sanitized and preserves missing-scope/rate-limit classification', async () => {
    for (const error of [new AttachmentError('MISSING_SCOPE'), new AttachmentError('RATE_LIMIT', 30),
      new AttachmentError('ACCESS_DENIED'), new Error('raw-private-secret')]) {
      const f = fixture(); f.authorize.mockRejectedValue(error);
      const result = await readImage(args, f.options, context);
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('raw-private-secret');
      if (error instanceof AttachmentError) expect(result).toMatchObject({ error: { code: error.code } });
      expect(f.download.request).not.toHaveBeenCalled(); expect(f.transport.request).not.toHaveBeenCalled();
    }
  });
  it('rejects unsupported type, oversized metadata, size mismatch and corrupt images before vision I/O', async () => {
    for (const modify of [
      (f: ReturnType<typeof fixture>) => { f.file.mimetype = 'image/webp'; },
      (f: ReturnType<typeof fixture>) => { f.file.size = L.fileBytes + 1; },
      (f: ReturnType<typeof fixture>) => { f.file.size++; },
      (f: ReturnType<typeof fixture>) => { f.file.mimetype = 'image/jpeg'; },
    ]) {
      const f = fixture(); modify(f);
      expect((await readImage(args, f.options, context)).ok).toBe(false); expect(f.transport.request).not.toHaveBeenCalled();
    }
    const corrupt = fixture(Buffer.from('not-a-png')); expect(await readImage(args, corrupt.options, context)).toMatchObject({ error: { code: 'INVALID_IMAGE' } });
    expect(corrupt.transport.request).not.toHaveBeenCalled();
  });
  it('reuses hardened Slack URL/DNS protection rather than creating another authenticated downloader', async () => {
    const f = fixture(); f.file.url_private_download = 'https://evil.example/private.png';
    expect(await readImage(args, f.options, context)).toMatchObject({ ok: false, error: { code: 'UNSAFE_URL' } });
    expect(f.download.request).not.toHaveBeenCalled(); expect(f.transport.request).not.toHaveBeenCalled();
  });
  it('accepts only file/message/thread/question arguments, not URL/base64/identity/model/config inputs', async () => {
    for (const extra of [{ url: 'https://evil.example' }, { image: 'base64' }, { model: 'other' }, { channelId: 'COTHER' },
      { requester: 'UOTHER' }, { botToken: 'secret' }, { signal: {} }]) {
      const f = fixture(); expect(imageInput.safeParse({ ...args, ...extra }).success).toBe(false);
      expect(await readImage({ ...args, ...extra }, f.options, context)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(f.authorize).not.toHaveBeenCalled();
    }
    expect(imageInput.safeParse({ ...args, question: 'x'.repeat(L.questionChars + 1) }).success).toBe(false);
    expect(createImageTools(fixture().options)).toHaveProperty('slack_analyze_image');
  });
  it('honors pre-cancel and cancellation after authorization without model or Slack download I/O', async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    expect(await readImage(args, f.options, context, controller.signal)).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.download.request).not.toHaveBeenCalled();
    const second = new AbortController(); const g = fixture();
    g.authorize.mockImplementation(async () => { second.abort(); return { file: g.file, channelId: 'C123', messageTs: args.messageTs }; });
    expect(await readImage(args, g.options, context, second.signal)).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(g.download.request).not.toHaveBeenCalled(); expect(g.transport.request).not.toHaveBeenCalled();
  });
});
