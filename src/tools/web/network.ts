import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";

export const LIMITS = { deadlineMs: 12_000, bodyBytes: 1_000_000, redirects: 3, textChars: 30_000 } as const;
const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
export const REQUEST_BODY_BYTES = 4096;
// Internal only; never exposed as model-controlled HTTP options.
export type SearchRequest = { method: 'POST'; body: string };
function validateRequest(url: URL, request?: SearchRequest) {
  if (request && (![EXA_SEARCH_URL, EXA_MCP_URL].includes(url.href) || request.method !== 'POST' || Buffer.byteLength(request.body) > REQUEST_BODY_BYTES)) {
    throw new WebError('INVALID_REQUEST');
  }
}
export class WebError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}
export type Address = { address: string; family: number };
export type Resolver = (host: string) => Promise<Address[]>;
export const resolvePublic: Resolver = (host) => lookup(host, { all: true, verbatim: true });

export function publicAddress(value: string): boolean {
  try {
    const address = ipaddr.process(value);
    if (address.range() !== "unicast") return false;
    if (address.kind() === "ipv6") {
      // Only global unicast; exclude special-purpose/documentation allocations.
      return address.match(ipaddr.parse("2000::"), 3) &&
        !["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"].some((cidr) => address.match(ipaddr.parseCIDR(cidr)));
    }
    return !["192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "198.18.0.0/15"].some((cidr) => address.match(ipaddr.parseCIDR(cidr)));
  } catch { return false; }
}

export function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebError("INVALID_URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.port || raw.length > 4096) throw new WebError("UNSAFE_URL");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!host || host.includes('%') || host.endsWith('.') || !host.includes('.') && !isIP(host) ||
      /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/iu.test(host) ||
      (isIP(host) && !publicAddress(host))) throw new WebError("UNSAFE_URL");
  url.hash = "";
  return url;
}

export async function verifiedAddress(url: URL, resolver: Resolver): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const candidates = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  if (!candidates.length || candidates.some((a) => !publicAddress(a.address) || isIP(a.address) !== a.family)) {
    throw new WebError("UNSAFE_ADDRESS");
  }
  return candidates[0]!;
}

// The URL hostname remains the HTTP Host / TLS servername and certificate identity.
// Only this verified address is supplied to the real socket's lookup. No second DNS
// lookup, pooled socket, proxy agent, ambient cookies, or environment credentials.
export function pinnedRequest(url: URL, address: Address, signal: AbortSignal, headers: Record<string, string> = {}, searchRequest?: SearchRequest): Promise<http.IncomingMessage> {
  validateRequest(url, searchRequest);
  if (url.href === EXA_MCP_URL && Object.keys(headers).some((key) => !['accept', 'content-type'].includes(key.toLowerCase()))) throw new WebError('INVALID_REQUEST');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: searchRequest?.method ?? 'GET', agent: false, signal, maxHeaderSize: 16_384,
      headers: { Accept: 'text/html, text/plain, application/json', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'MyMastra-PublicReader/1.0', ...headers },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      ...(url.protocol === 'https:' ? { rejectUnauthorized: true, servername: isIP(url.hostname.replace(/^\[|\]$/gu, '')) ? undefined : url.hostname } : {}),
    }, resolve);
    request.on('error', reject);
    request.end(searchRequest?.body);
  });
}
export type Connector = typeof pinnedRequest;
export interface NetworkDependencies { resolver?: Resolver; connector?: Connector; deadlineMs?: number }

export async function readBody(response: http.IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder && encoding !== 'identity') { response.destroy(); throw new WebError('UNSUPPORTED_ENCODING'); }
  const stream = decoder ? response.pipe(decoder) : response;
  let wireBytes = 0;
  response.on('data', (chunk: Buffer) => {
    wireBytes += chunk.length;
    if (wireBytes > LIMITS.bodyBytes) { stream.destroy(new WebError('BODY_LIMIT')); response.destroy(); }
  });
  response.on('error', (error) => stream.destroy(error));
  const abort = () => { stream.destroy(new WebError('TIMEOUT', true)); response.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > LIMITS.bodyBytes) throw new WebError('BODY_LIMIT');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy(); response.destroy();
  }
}

export async function download(raw: string, dependencies: NetworkDependencies = {}, headers: Record<string, string> = {}, redirects: number = LIMITS.redirects, searchRequest?: SearchRequest): Promise<{ body: Buffer; finalUrl: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.deadlineMs ?? LIMITS.deadlineMs);
  const signal = controller.signal;
  // Racing also bounds a resolver/connector implementation that does not support cancellation.
  let abortListener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new WebError('TIMEOUT', true));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  const operation = async () => {
    let url = publicUrl(raw);
    validateRequest(url, searchRequest);
    if (searchRequest && redirects !== 0) throw new WebError('INVALID_REQUEST');
    for (let hop = 0; ; hop++) {
      const address = await verifiedAddress(url, dependencies.resolver ?? resolvePublic);
      if (signal.aborted) throw new WebError('TIMEOUT', true);
      const response = await (dependencies.connector ?? pinnedRequest)(url, address, signal, headers, searchRequest);
      if (signal.aborted) { response.destroy(); throw new WebError('TIMEOUT', true); }
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (hop >= redirects || !response.headers.location) throw new WebError('REDIRECT_LIMIT');
        // Secret-bearing search requests have redirects disabled. Public reader headers have no credentials.
        url = publicUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        const code = searchRequest && status === 402 ? 'CREDIT_EXHAUSTED' : searchRequest && status === 401 ? 'AUTH_ERROR' : status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR';
        throw new WebError(code, status === 429 || status >= 500);
      }
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      const allowedType = searchRequest && url.href === EXA_MCP_URL
        ? /^(application\/json|text\/event-stream)(?:;|$)/u
        : /^(text\/html|text\/plain|application\/json)(?:;|$)/u;
      if (!allowedType.test(contentType) ||
          /charset\s*=\s*"?(?!utf-8\b|us-ascii\b)[^;\s"]+/u.test(contentType)) {
        response.destroy(); throw new WebError('UNSUPPORTED_TYPE');
      }
      const body = await readBody(response, signal);
      return { body, finalUrl: url.href, contentType };
    }
  };
  try { return await Promise.race([operation(), aborted]); }
  catch (error) { if (error instanceof WebError) throw error; throw new WebError('NETWORK_ERROR', true); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abortListener); }
}
