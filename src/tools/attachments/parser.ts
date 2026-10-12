import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ATTACHMENT_LIMITS as L, AttachmentError, type AttachmentKind, type ParsedAttachment } from './policy.js';
import { parserProgram } from './worker-source.js';
const parsedSchema = z.object({ kind: z.enum(['text', 'csv', 'pdf']),
  units: z.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive(),
    text: z.string().optional(), cells: z.array(z.string()).optional(), page: z.number().int().positive().optional() })).max(L.units),
  totalUnits: z.number().int().min(0).max(L.units), emptyPages: z.array(z.number().int().positive()).max(L.pdfPages).optional() });
const codes = z.enum(['FILE_LIMIT', 'UNSUPPORTED_TYPE', 'INVALID_UTF8', 'INVALID_CSV', 'ENCRYPTED_PDF', 'NO_TEXT_PDF', 'PARSER_LIMIT', 'INVALID_PDF', 'PDF_UNAVAILABLE']);
/** Trusted, absolute file URL for pdfjs-dist/legacy/build/pdf.mjs (4.10.38).
 * Never accept from model input. Module executes only inside the bounded child. */
export type ParserOptions = { pdfModuleURL?: string };
let activeParsers = 0;
/** Kill on cancellation/limits, but settle and release the parser slot ONLY after actual child close. */
export async function parseAttachment(body: Buffer, kind: AttachmentKind, explicit?: AbortSignal, options: ParserOptions = {}): Promise<ParsedAttachment> {
  const signal = explicit;
  if (options.pdfModuleURL) {
    let url: URL;
    try { url = new URL(options.pdfModuleURL); } catch { throw new AttachmentError('PDF_UNAVAILABLE'); }
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) throw new AttachmentError('PDF_UNAVAILABLE');
  }
  if (signal?.aborted) throw new AttachmentError('PARSER_LIMIT');
  if (body.length > L.fileBytes) throw new AttachmentError('FILE_LIMIT');
  if (activeParsers >= 2) throw new AttachmentError('PARSER_LIMIT');
  activeParsers++;
  return new Promise<ParsedAttachment>((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${L.parserHeapMb}`, '--input-type=module',
      '-e', parserProgram, JSON.stringify(L), kind, options.pdfModuleURL ?? ''], { cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let failure: AttachmentError | undefined;
    const kill = () => { failure ??= new AttachmentError('PARSER_LIMIT'); child.kill('SIGKILL'); };
    const timer = setTimeout(kill, L.parserMs);
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    const output: Buffer[] = []; let outputBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > L.parsedBytes + 4096) { kill(); return; }
      output.push(Buffer.from(chunk));
    });
    child.on('error', kill);
    child.stdin.on('error', () => { /* Child close determines sanitized failure. */ });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', kill);
      if (failure || code !== 0 || signal?.aborted) { reject(failure ?? new AttachmentError('PARSER_LIMIT')); return; }
      try {
        const raw = JSON.parse(Buffer.concat(output).toString('utf8').trim().split('\n').at(-1)!);
        if (raw.error) { reject(new AttachmentError(codes.parse(raw.error))); return; }
        const value = parsedSchema.parse(raw);
        if (value.kind !== kind || value.totalUnits !== value.units.length) throw new Error();
        resolve(value);
      } catch { reject(new AttachmentError('PARSER_LIMIT')); }
    });
    child.stdin.end(body);
  }).finally(() => { activeParsers--; });
}
