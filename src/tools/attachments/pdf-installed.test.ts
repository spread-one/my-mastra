import { describe, expect, it } from 'vitest';
import { parseAttachment } from './parser.js';
import { pdfFixture } from './fixtures.test-helper.js';

const parserOptions = { pdfModuleURL: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs') };
describe('installed PDF.js 4.10.38 in the real bounded Node child', () => {
  it('extracts compressed real PDF bytes with the installed legacy module (no synthetic parser)', async () => {
    expect(parserOptions.pdfModuleURL).toMatch(/^file:.*\/pdfjs-dist\/legacy\/build\/pdf.mjs$/u);
    const parsed = await parseAttachment(pdfFixture(['First page', 'Second page'], { compressed: true }), 'pdf', undefined, parserOptions);
    expect(parsed.kind).toBe('pdf'); expect(parsed.totalUnits).toBe(2);
    expect(parsed.units.map(unit => unit.text)).toEqual(['First page', 'Second page']);
  });
  it.each([
    [pdfFixture(['secret'], { encrypted: true }), 'ENCRYPTED_PDF'],
    [Buffer.from('%PDF-1.7\nnot a document\n%%EOF'), 'INVALID_PDF'],
    [pdfFixture([''], { scanned: true }), 'NO_TEXT_PDF'],
    [pdfFixture(['Hello'], { compressed: true, streamFilter: '/LZWDecode' }), 'UNSUPPORTED_TYPE'],
  ] as const)('fails safely on an encrypted/malformed/no-text/unsupported PDF %#', async (pdf, code) => {
    await expect(parseAttachment(pdf, 'pdf', undefined, parserOptions)).rejects.toThrow(code);
  });
  it('reports missing trusted module safely, not successful empty extraction', async () => {
    await expect(parseAttachment(pdfFixture(['Hello']), 'pdf', undefined,
      { pdfModuleURL: new URL('missing-trusted-pdf.mjs', import.meta.url).href })).rejects.toThrow('PDF_UNAVAILABLE');
  });
});
