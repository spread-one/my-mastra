import { types } from 'node:util';
const validTs = (value: unknown): value is string => typeof value === 'string' && /^\d{1,16}\.\d{1,6}$/u.test(value);

export type FileCandidate = { fileId: string; messageTs: string; threadTs?: string; name?: string; mimetype?: string };
/** Candidate hints only, never authority or contents. All-or-nothing bounded primitive projection. */
export function projectFileCandidates(raw: unknown, ts: string, threadTs?: string): FileCandidate[] {
  if (!validTs(ts) || (threadTs !== undefined && !validTs(threadTs))) throw new Error('INVALID_FILES');
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10) throw new Error('INVALID_FILES');
  const seen = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_FILES');
    const get = (key: string) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && !('value' in d)) throw new Error('INVALID_FILES');
      return d?.value as unknown;
    };
    const fileId = get('id'), name = get('name'), mimetype = get('mimetype');
    if (typeof fileId !== 'string' || !/^F[A-Z0-9]{2,63}$/u.test(fileId) || seen.has(fileId) ||
        (name !== undefined && (typeof name !== 'string' || name.length > 512 || /[\x00-\x1f]/u.test(name))) ||
        (mimetype !== undefined && (typeof mimetype !== 'string' || mimetype.length > 200 || /[\x00-\x1f]/u.test(mimetype)))) throw new Error('INVALID_FILES');
    seen.add(fileId);
    return { fileId, messageTs: ts, ...(threadTs ? { threadTs } : {}),
      ...(typeof name === 'string' ? { name } : {}), ...(typeof mimetype === 'string' ? { mimetype } : {}) };
  });
}
