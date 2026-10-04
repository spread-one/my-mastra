import { writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs';

/** No tokens, payloads or SDK errors are persisted. Socket state is sampled, not process liveness. */
export function healthReady(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as { ready?: unknown; time?: unknown };
  return state.ready === true && typeof state.time === 'number' && state.time <= now && now - state.time < 10_000;
}
export function checkHealth(path: string, now = Date.now()): boolean {
  try { return healthReady(JSON.parse(readFileSync(path, 'utf8')), now); } catch { return false; }
}
export function reportHealth(path: string | undefined, ready: () => boolean, failed: () => void): () => void {
  if (!path) return () => {};
  const publish = () => {
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify({ ready: ready(), time: Date.now() }), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch { failed(); }
  };
  publish();
  const timer = setInterval(publish, 2_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    try { rmSync(path, { force: true }); rmSync(`${path}.tmp`, { force: true }); } catch { failed(); }
  };
}
