import https from 'node:https';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';
import { ATTACHMENT_LIMITS as L, AttachmentError } from './policy.js';

export function slackDownloadUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AttachmentError('UNSAFE_URL'); }
  // No suffix wildcard, signed external CDN, alternate port, userinfo or fragments.
  if (url.origin !== 'https://files.slack.com' || url.username || url.password || url.hash ||
      !url.pathname.startsWith('/files-pri/') || /[\\\x00-\x20]/u.test(value)) throw new AttachmentError('UNSAFE_URL');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new AttachmentError('UNSAFE_URL'); }
  if (/[\\\x00-\x20]/u.test(path) || /%(?:2f|5c|2e|00)/iu.test(value) ||
      path.split('/').some(segment => segment === '.' || segment === '..')) throw new AttachmentError('UNSAFE_URL');
  return url;
}
export function publicAddress(address: string): boolean {
  try { const ip = ipaddr.process(address); return ip.range() === 'unicast'; } catch { return false; }
}
export type DownloadDependencies = {
  resolve?: typeof lookup;
  request?: typeof https.request;
  signal?: AbortSignal;
};
/** Authenticated Slack-only path. Redirects never broaden credential scope, DNS is pinned per hop. */
export async function downloadAttachment(value: string, token: string, deps: DownloadDependencies = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), L.downloadMs);
  const shared = deps.signal;
  const signal = shared ? AbortSignal.any([shared, controller.signal]) : controller.signal;
  const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(new AttachmentError('DOWNLOAD_FAILED'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
  try {
    let url = slackDownloadUrl(value);
    if (!token || /[\x00-\x20\x7f]/u.test(token)) throw new AttachmentError('DOWNLOAD_FAILED');
    for (let hop = 0; hop <= L.redirects; hop++) {
      signal.throwIfAborted();
      const addresses = await abortable((deps.resolve ?? lookup)(url.hostname, { all: true, verbatim: true }));
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new AttachmentError('UNSAFE_URL');
      const pinned = addresses[0]!;
      const response = await abortable(new Promise<IncomingMessage>((resolve, reject) => {
        const req = (deps.request ?? https.request)(url, { method: 'GET', signal,
          agent: false, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' },
          lookup: (_host, options, callback) => {
            if ((options as { all?: boolean }).all) callback(null, [pinned] as never);
            else callback(null, pinned.address, pinned.family);
          },
        }, resolve);
        req.on('error', reject); req.end();
      }));
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (hop === L.redirects || !response.headers.location) throw new AttachmentError('UNSAFE_URL');
        url = slackDownloadUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (status !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); throw new AttachmentError('DOWNLOAD_FAILED');
      }
      const size = response.headers['content-length'];
      if (size && (!/^\d+$/u.test(size) || Number(size) > L.fileBytes)) {
        response.destroy(); throw new AttachmentError('FILE_LIMIT');
      }
      let length = 0; const chunks: Buffer[] = [];
      for await (const chunk of response) {
        length += chunk.length;
        if (length > L.fileBytes) { response.destroy(); throw new AttachmentError('FILE_LIMIT'); }
        chunks.push(Buffer.from(chunk));
      }
      return { body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? '') };
    }
    throw new AttachmentError('UNSAFE_URL');
  } catch (error) { if (error instanceof AttachmentError) throw error; throw new AttachmentError('DOWNLOAD_FAILED'); }
  finally { clearTimeout(timer); controller.abort(); }
}
