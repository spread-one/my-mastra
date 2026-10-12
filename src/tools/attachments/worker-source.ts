// Deliberately plain JS: executed by Node 20+ in a separate token-free process, not the main loop.
export const parserProgram = String.raw`
import { inflateSync } from 'node:zlib';
const L = JSON.parse(process.argv[1]);
const kind = process.argv[2];
const fail = code => { throw Object.assign(new Error(), { code }); };
const chunks = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > L.fileBytes) fail('FILE_LIMIT'); chunks.push(chunk); }
const body = Buffer.concat(chunks);
let parsedBytes = 0;
const units = [];
const add = unit => {
  parsedBytes += Buffer.byteLength(JSON.stringify(unit));
  if (parsedBytes > L.parsedBytes || units.length >= L.units) fail('PARSER_LIMIT');
  units.push(unit);
};
try {
  if (kind !== 'pdf') {
    const signature = body.subarray(0, 8);
    if (signature.subarray(0, 5).toString() === '%PDF-' || signature.subarray(0, 2).toString() === 'PK' ||
        /^(?:GIF87a|GIF89a)/u.test(signature.toString('ascii')) || signature.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
        signature.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) fail('UNSUPPORTED_TYPE');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { fail('INVALID_UTF8'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || /^\s*%PDF-/u.test(text)) fail('UNSUPPORTED_TYPE');
    text = text.replace(/\r\n?/gu, '\n');
    if (kind === 'text') {
      const lines = text ? text.split('\n') : [];
      lines.forEach((text, index) => add({ start: index + 1, end: index + 1, text }));
    } else {
      let cells = [], cell = '', state = 'start', line = 1, start = 1, rows = 0;
      const pushCell = () => {
        if (Buffer.byteLength(cell) > L.cellBytes || cells.length >= L.csvCols) fail('PARSER_LIMIT');
        cells.push(cell); cell = ''; state = 'start';
      };
      const pushRow = () => {
        pushCell(); if (++rows > L.csvRows) fail('PARSER_LIMIT');
        add({ start, end: line, cells }); cells = []; start = line + 1;
      };
      // No spreadsheet engine, eval, formula interpretation or URL fetching.
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (state === 'quoted') {
          if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; }
          else { cell += c; if (c === '\n') line++; }
        } else if (c === ',') { pushCell(); }
        else if (c === '\n') { pushRow(); line++; }
        else if (c === '"' && state === 'start') state = 'quoted';
        else { if (state === 'closed' || c === '"') fail('INVALID_CSV'); cell += c; state = 'bare'; }
        // Bound cells during accumulation, not only at their terminators (UTF-16 <= UTF-8 bytes).
        if (cell.length > L.cellBytes) fail('PARSER_LIMIT');
      }
      if (state === 'quoted') fail('INVALID_CSV');
      if (text && !text.endsWith('\n')) pushRow();
    }
    console.log(JSON.stringify({ kind, units, totalUnits: units.length }));
  } else {
    if (!/^%PDF-1\.[0-7]/u.test(body.subarray(0, 8).toString('ascii')) || !/%%EOF\s*$/u.test(body.subarray(-1024).toString('latin1'))) fail('INVALID_PDF');
    const raw = body.toString('latin1');
    if (/\/Encrypt\b/u.test(raw)) fail('ENCRYPTED_PDF');
    // Lex PDF objects (strings/comments/hex are opaque), so forged /Length or /Filter
    // text inside literal strings cannot bypass decompression accounting.
    let position = 0, tokenCount = 0, inflated = 0;
    const pushed = [];
    const lex = () => {
      if (pushed.length) return pushed.pop();
      while (position < raw.length) {
        if (/[\x00\t\n\f\r ]/u.test(raw[position])) { position++; continue; }
        if (raw[position] === '%') { while (position < raw.length && !/[\r\n]/u.test(raw[position])) position++; continue; }
        break;
      }
      if (position >= raw.length) return null;
      if (++tokenCount > 200000) fail('PARSER_LIMIT');
      const c = raw[position++];
      if (c === '(') {
        let depth = 1;
        while (position < raw.length && depth) {
          const x = raw[position++];
          if (x === '\\') position++;
          else if (x === '(') depth++;
          else if (x === ')') depth--;
          if (depth > 100) fail('PARSER_LIMIT');
        }
        if (depth) fail('INVALID_PDF'); return { opaque: true };
      }
      if (c === '<') {
        if (raw[position] === '<') { position++; return '<<'; }
        while (position < raw.length && raw[position] !== '>') position++;
        if (position >= raw.length) fail('INVALID_PDF'); position++; return { opaque: true };
      }
      if (c === '>' && raw[position] === '>') { position++; return '>>'; }
      if ('[]{}>'.includes(c)) return c;
      const start = position - 1;
      while (position < raw.length && !/[\x00\t\n\f\r ()[\]{}<>/%]/u.test(raw[position])) position++;
      const token = raw.slice(start, position);
      if (token.startsWith('/') && token.includes('#')) fail('PARSER_LIMIT');
      return /^[-+]?\d+(?:\.\d+)?$/u.test(token) ? Number(token) : token;
    };
    const read = (token, depth = 0) => {
      if (depth > 50) fail('PARSER_LIMIT');
      if (token === '<<') {
        const dict = Object.create(null);
        while (true) {
          const key = lex(); if (key === '>>') break;
          if (typeof key !== 'string' || !key.startsWith('/') || key in dict) fail('INVALID_PDF');
          const value = lex(); if (value === null) fail('INVALID_PDF');
          dict[key] = read(value, depth + 1);
        }
        return { dict };
      }
      if (token === '[') {
        const array = [];
        while (true) { const value = lex(); if (value === ']') break; if (value === null) fail('INVALID_PDF'); array.push(read(value, depth + 1)); }
        return array;
      }
      if (typeof token === 'number') {
        const second = lex();
        if (typeof second === 'number') {
          const third = lex();
          if (third === 'R') return { reference: true };
          if (third !== null) pushed.push(third);
        }
        if (second !== null) pushed.push(second);
      }
      return token;
    };
    let previous;
    while (true) {
      const token = lex(); if (token === null) break;
      if (token !== 'stream') { previous = read(token); continue; }
      if (!previous?.dict || pushed.length) fail('INVALID_PDF');
      const dict = previous.dict, count = dict['/Length'];
      // PDF.js prefers F over Filter and DP over DecodeParms. Predictors may allocate
      // far beyond raw inflate output. This subset forbids these keys outright, even
      // null/array/indirect values, before inflate or the PDF.js import (no normalization).
      if (['/F', '/DP', '/DecodeParms'].some(key => Object.hasOwn(dict, key))) fail('UNSUPPORTED_TYPE');
      if (!Number.isSafeInteger(count) || count < 0) fail('PARSER_LIMIT');
      const newline = /^(?:\r\n|\n)/u.exec(raw.slice(position));
      if (!newline) fail('PARSER_LIMIT');
      const begin = position + newline[0].length, end = begin + count;
      if (end > body.length || !/^(?:\r\n|\n)?endstream\b/u.test(raw.slice(end, end + 20))) fail('INVALID_PDF');
      const filter = dict['/Filter']; let bytes = count;
      if (filter !== undefined) {
        if (filter !== '/FlateDecode' && !(Array.isArray(filter) && filter.length === 1 && filter[0] === '/FlateDecode')) fail('UNSUPPORTED_TYPE');
        try { bytes = inflateSync(body.subarray(begin, end), { maxOutputLength: L.inflatedStreamBytes }).length; }
        catch { fail('PARSER_LIMIT'); }
      }
      inflated += bytes;
      if (bytes > L.inflatedStreamBytes || inflated > L.inflatedTotalBytes) fail('PARSER_LIMIT');
      position = end + /^(?:\r\n|\n)?endstream\b/u.exec(raw.slice(end, end + 20))[0].length;
      previous = undefined;
    }
    if (!process.argv[3]) fail('PDF_UNAVAILABLE');
    let pdfModule;
    try { pdfModule = await import(process.argv[3]); } catch { fail('PDF_UNAVAILABLE'); }
    const { getDocument, PasswordResponses, VerbosityLevel } = pdfModule;
    const task = getDocument({ data: new Uint8Array(body), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true,
      disableAutoFetch: true, disableStream: true, verbosity: VerbosityLevel.ERRORS,
      maxImageSize: 0, cMapUrl: undefined, standardFontDataUrl: undefined });
    let doc;
    try { doc = await task.promise; } catch (error) {
      if (error.name === 'PasswordException' || error.code === PasswordResponses.NEED_PASSWORD) fail('ENCRYPTED_PDF');
      fail('INVALID_PDF');
    }
    if (doc.numPages > L.pdfPages) { await task.destroy(); fail('PARSER_LIMIT'); }
    const emptyPages = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const current = await doc.getPage(page);
      const stream = current.streamTextContent({ disableNormalization: false, includeMarkedContent: false });
      const reader = stream.getReader(); let text = '', itemCount = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        for (const item of value.items) {
          if (++itemCount > L.units) fail('PARSER_LIMIT');
          if (typeof item.str !== 'string') continue;
          text += item.str + (item.hasEOL ? '\n' : ' ');
          if (Buffer.byteLength(text) > L.parsedBytes) fail('PARSER_LIMIT');
        }
      }
      text = text.trim();
      if (!text) emptyPages.push(page);
      add({ start: page, end: page, page, text }); current.cleanup();
    }
    await doc.destroy();
    if (emptyPages.length === units.length) fail('NO_TEXT_PDF');
    console.log(JSON.stringify({ kind, units, totalUnits: units.length, emptyPages }));
  }
} catch (error) { console.log(JSON.stringify({ error: error.code || 'INVALID_PDF' })); }
`;
