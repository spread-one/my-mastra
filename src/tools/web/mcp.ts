import { z } from 'zod';
import { WebError } from './network.js';

export const SEARCH_OBJECTIVE = 'Find relevant public web sources for the query and return search excerpts.';
const EMPTY = 'No search results found. Please try a different query.';
const envelope = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal(1),
  result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1).max(10) }),
}).passthrough();

// Finite buffered SSE only: no sessions, streaming callbacks, reconnects or tools discovery.
export function parseMcp(body: Buffer, contentType: string) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  let message = text;
  if (contentType.startsWith('text/event-stream')) {
    const events: string[] = [];
    let data: string[] = [];
    const flush = () => { if (data.length) events.push(data.join('\n')); data = []; };
    for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
      if (!line) flush();
      else if (line.startsWith(':')) continue;
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
      else if (!/^(event|id|retry):/u.test(line)) throw new WebError('INVALID_RESPONSE');
    }
    flush();
    if (events.length !== 1) throw new WebError('INVALID_RESPONSE');
    message = events[0]!;
  }
  const raw: unknown = JSON.parse(message);
  if (!raw || typeof raw !== 'object' || 'error' in raw) throw new WebError('INVALID_RESPONSE');
  const parsed = envelope.parse(raw);
  if (parsed.result.isError) throw new WebError('MCP_SEARCH_ERROR');
  const combined = parsed.result.content.map((item) => item.text).join('\n\n---\n\n');
  if (combined === EMPTY) return { results: [] };
  // Only the basic tool's structured labels are citations; arbitrary prose/JSON is not.
  const results = combined.split('\n\n---\n\n').map((block) => {
    const match = /^Title: ([^\r\n]*)\nURL: ([^\s]+)\nPublished: ([^\r\n]+)\nAuthor: [^\r\n]+(?:\n(?:Highlights:\n|Text: )([\s\S]*))?$/u.exec(block);
    if (!match) throw new WebError('INVALID_RESPONSE');
    return { title: match[1] === 'N/A' ? '' : match[1]!, url: match[2]!, highlights: match[4] ? [match[4]] : [], ...(match[3] !== 'N/A' ? { publishedDate: match[3] } : {}) };
  });
  return { results };
}
