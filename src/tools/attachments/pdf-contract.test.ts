import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parseAttachment } from './parser.js';
import { pdfFixture } from './fixtures.test-helper.js';

it('runs injected PDF module only in bounded token-free child, with disabled eval/fetch and page citations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-pdf-'));
  try {
    const module = join(dir, 'mock.mjs');
    await writeFile(module, `
      export const PasswordResponses = { NEED_PASSWORD: 1 };
      export const VerbosityLevel = { ERRORS: 0 };
      export function getDocument(options) {
        if (options.isEvalSupported !== false || options.useWorkerFetch !== false ||
            options.enableXfa !== false || options.disableFontFace !== true ||
            options.disableAutoFetch !== true || Object.keys(process.env).some(k => /TOKEN|KEY|NODE_OPTIONS/.test(k))) throw Error();
        const doc = { numPages: 3, destroy: async () => {}, getPage: async page => ({
          cleanup() {}, streamTextContent() { return new ReadableStream({ start(c) {
            c.enqueue({ items: [{ str: page === 2 ? '' : '한글 page ' + page, hasEOL: true }] }); c.close();
          } }); }
        }) };
        return { promise: Promise.resolve(doc), destroy: async () => {} };
      }
    `);
    const options = { pdfModuleURL: pathToFileURL(module).href };
    const result = await parseAttachment(pdfFixture(['one', '', 'three'], { compressed: true }), 'pdf', undefined, options);
    expect(result.units.map(p => [p.page, p.text])).toEqual([[1, '한글 page 1'], [2, ''], [3, '한글 page 3']]);
    expect(result.emptyPages).toEqual([2]);
    await writeFile(module, `export const PasswordResponses = {}; export const VerbosityLevel = {}; export function getDocument() { return { promise: Promise.resolve({ numPages: 51 }), destroy: async () => {} }; }`);
    await expect(parseAttachment(pdfFixture(['text']), 'pdf', undefined, options)).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    await writeFile(module, `export const PasswordResponses = {}; export const VerbosityLevel = {}; export function getDocument() {
      return { promise: Promise.resolve({ numPages: 1, destroy: async () => {}, getPage: async () => ({ cleanup() {},
        streamTextContent() { return new ReadableStream({ start(c) { c.enqueue({items: []}); c.close(); } }); }
      }) }) };
    }`);
    await expect(parseAttachment(pdfFixture(['']), 'pdf', undefined, options)).rejects.toMatchObject({ code: 'NO_TEXT_PDF' });
    await expect(parseAttachment(pdfFixture(['text']), 'pdf', undefined, { pdfModuleURL: 'https://evil.example/parser.js' }))
      .rejects.toMatchObject({ code: 'PDF_UNAVAILABLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
