import { bytes, SLACK_LIMITS as limits } from './limits.js';

export type OutputBlock =
  | { type: 'section'; text: { type: 'mrkdwn' | 'plain_text'; text: string }; }
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: false } }
  | { type: 'divider' };
type Run = { text: string; open?: string; close?: string; atomic?: boolean; code?: boolean; boundary?: boolean; plain: string };
export const escapeSlack = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const fail = (): never => { throw new Error('SLACK_OUTPUT_LIMIT'); };

// Only explicitly validated Markdown links produce Slack angle syntax. Raw model
// controls (including pre-existing entities) always pass through escapeSlack.
function safeUrl(raw: string): string | undefined {
  if (!/^https?:\/\//iu.test(raw) || /[\s<>|\\`]/u.test(raw)) return;
  try {
    const url = new URL(raw);
    if (url.username || url.password || !url.hostname.includes('.') || url.hostname.endsWith('.') ||
        /^[\d.]+$/u.test(url.hostname) || url.hostname.includes(':') ||
        /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|corp|onion|test|invalid|home\.arpa)$/iu.test(url.hostname)) return;
    return escapeSlack(url.href);
  } catch { return; }
}

function inline(source: string, literal = false): Run[] {
  if (literal) return [{ text: escapeSlack(source), plain: source }];
  const runs: Run[] = [];
  // Code is tokenized before emphasis/links, and is never recursively formatted.
  const pattern = /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([\s\S]+?)\*\*|(?<![\p{L}\p{N}_])__([\s\S]+?)__(?![\p{L}\p{N}_])|~~([\s\S]+?)~~|\*([^*]+?)\*|(?<![\p{L}\p{N}_])_([^_]+?)_(?![\p{L}\p{N}_])/gu;
  let start = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > start) runs.push(...inline(source.slice(start, match.index), true));
    if (match[1]) {
      const content = escapeSlack(match[2]!);
      // Slack cannot quote literal backticks inside code spans: keep readable text.
      runs.push({ text: content, plain: match[2]!, code: true, ...(!content.includes('`') ? { open: '`', close: '`' } : {}) });
    } else if (match[3]) {
      const label = escapeSlack(match[3]); const url = safeUrl(match[4]!);
      const plain = `${match[3]} (${match[4]})`;
      runs.push(url && !/[|`*~_]/u.test(label) && url.length + label.length + 3 <= limits.sectionChars
        ? { text: `<${url}|${label}>`, atomic: true, plain }
        : { text: escapeSlack(plain), plain });
    } else {
      const content = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9]!;
      const marker = match[5] || match[6] ? '*' : match[7] ? '~' : '_';
      if (marker === '*' && /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(source.slice(0, match.index))) runs.push({ text: ' ', plain: '' });
      for (const run of inline(content)) runs.push({ ...run, open: marker + (run.open ?? ''), close: (run.close ?? '') + marker });
      if (marker === '*' && /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source.slice(match.index + match[0].length))) {
        runs.push({ text: ' ', plain: '' });
      }
    }
    start = match.index + match[0].length;
  }
  if (start < source.length) runs.push(...inline(source.slice(start), true));
  return runs;
}

// Split by codepoint or complete escaped entity; wrappers are balanced per chunk.
function units(text: string): string[] { return text.match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? []; }
function sections(runs: Run[], type: 'mrkdwn' | 'plain_text' = 'mrkdwn'): OutputBlock[] {
  const result: OutputBlock[] = []; let part = '';
  const flush = () => { if (part) result.push({ type: 'section', text: { type, text: part } }); part = ''; };
  for (const [index, run] of runs.entries()) {
    // Prefer a complete paragraph/card in the next section when it fits there.
    // Overlong groups still split losslessly with balanced wrappers below.
    if (run.boundary && part) {
      let groupLength = 0;
      for (let next = index; next < runs.length && (next === index || !runs[next]!.boundary); next++) {
        const item = runs[next]!;
        groupLength += item.text.length + (item.open?.length ?? 0) + (item.close?.length ?? 0);
      }
      if (groupLength <= limits.sectionChars && part.length + groupLength > limits.sectionChars) flush();
    }
    const open = run.open ?? '', close = run.close ?? '';
    let chunk = '';
    const append = () => { if (chunk) part += open + chunk + close; chunk = ''; };
    for (const unit of run.atomic ? [run.text] : type === 'plain_text' ? Array.from(run.text) : units(run.text)) {
      if (unit.length + open.length + close.length > limits.sectionChars) fail();
      if (part.length + open.length + chunk.length + unit.length + close.length > limits.sectionChars) { append(); flush(); }
      chunk += unit;
    }
    append();
  }
  flush(); return result;
}

function cells(line: string): string[] | undefined {
  if (!line.includes('|')) return;
  const result: string[] = []; let cell = '', ticks = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '|') { cell += '|'; i++; }
    else if (c === '`') { ticks = ticks ? 0 : 1; cell += c; }
    else if (c === '|' && !ticks) { result.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  result.push(cell.trim());
  if (line.trimStart().startsWith('|')) result.shift();
  if (line.trimEnd().endsWith('|')) result.pop();
  return result;
}

export function renderMarkdown(source: string): { blocks: OutputBlock[]; fallback: string } {
  const blocks: OutputBlock[] = [], fallback: string[] = [];
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  let pending: Run[] = [], gap = '\n\n';
  const flushSections = () => { blocks.push(...sections(pending)); pending = []; gap = '\n\n'; };
  const pack = (runs: Run[]) => {
    if (pending.length) pending.push({ text: gap, plain: gap, boundary: true });
    pending.push(...runs); gap = '\n\n';
  };
  const add = (text: string, heading = false) => {
    const runs = inline(text).map(run => run.open || run.atomic || run.code ? run : { ...run, text: run.text.replace(/^❯ /gmu, '> ') });
    const plain = runs.map(run => run.plain).join('');
    fallback.push(escapeSlack(plain));
    if (heading) {
      flushSections();
      if (plain.length <= 150 && plain.trim()) blocks.push({ type: 'header', text: { type: 'plain_text', text: plain, emoji: false } });
      else blocks.push(...sections(runs.map(run => ({ ...run, open: '*' + (run.open ?? ''), close: (run.close ?? '') + '*' }))));
    } else pack(runs);
  };
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { add(paragraph.join('\n')); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence && !(fence[1]!.startsWith('`') && fence[2]!.includes('`'))) {
      flush(); const content: string[] = []; const marker = fence[1]!;
      while (++i < lines.length) {
        if (new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`, 'u').test(lines[i]!)) break;
        content.push(lines[i]!);
      }
      const literal = content.join('\n'); const code = escapeSlack(literal);
      const info = fence[2]!.trim();
      if (info) { fallback.push(escapeSlack(info)); pack(inline(info, true)); }
      if (!literal) {
        const empty = '(빈 코드 블록)'; fallback.push(empty); pack(inline(empty, true));
      } else {
        fallback.push(code);
        if (literal.includes('```')) {
          flushSections();
          blocks.push(...sections([{ text: literal, plain: literal }], 'plain_text'));
        } else pack([{ text: code, plain: literal, open: '```\n', close: '\n```' }]);
      }
      continue;
    }
    const header = cells(line), separator = cells(lines[i + 1] ?? '');
    if (header && separator && header.length === separator.length && separator.every(cell => /^:?-{3,}:?$/u.test(cell))) {
      flush(); i++;
      let rows = 0;
      while (i + 1 < lines.length) {
        const row = cells(lines[i + 1]!); if (!row) break; i++; rows++;
        const count = Math.max(header.length, row.length);
        add(Array.from({ length: count }, (_, column) => `${column ? '  ' : '• '}${header[column] || `열 ${column + 1}`}: ${row[column] ?? '(빈 값)'}`).join('\n'));
      }
      if (!rows) add(header.join(' | '));
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/u);
    if (heading) { flush(); add(heading[1]!, true); }
    else if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { flush(); flushSections(); blocks.push({ type: 'divider' }); fallback.push('—'); }
    else if (!line.trim()) {
      flush(); fallback.push('');
      if (i > 0 && !lines[i - 1]!.trim()) gap += '\n';
    }
    else paragraph.push(line.replace(/^(\s*)[-+*]\s+/u, '$1• ').replace(/^\s*>\s?/u, '❯ '));
  }
  flush(); flushSections();
  const transformed = blocks.map(block => block.type === 'divider' ? '' : block.text.text).join('');
  const text = fallback.join('\n');
  if (!blocks.length || blocks.length > limits.blocks || transformed.length > limits.outputChars || bytes(transformed) > limits.outputBytes || text.length > 39_000 || bytes(text) > limits.outputBytes) fail();
  return { blocks, fallback: text };
}
