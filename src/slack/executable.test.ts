import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Execute the real entry body with only env loading and network transport replaced.
 * No host .env is read and no actual Socket/LLM connection is made. */
async function execute(mode: 'SIGINT' | 'SIGTERM' | 'rejection' | 'exception') {
  const source = readFileSync(new URL('../slack.ts', import.meta.url), 'utf8')
    .replace("import { config } from 'dotenv';", 'const config = () => {};')
    .replace("import { runSlack } from './slack/run.js';", `
      const runSlack = async ({ signal }: { signal: AbortSignal }) => {
        const keepAlive = setInterval(() => {}, 1_000); // Simulate SDK sockets keeping the event loop open.
        const result = new Promise<number>(resolve => signal.addEventListener('abort', () => {
          clearInterval(keepAlive); process.stderr.write('mock_stopped\\n'); resolve(130);
        }, { once: true }));
        process.stdout.write('mock_ready\\n');
        if (process.env.TEST_FAULT === 'rejection') setTimeout(() => { void Promise.reject(new Error('synthetic-private-token-body')); }, 10);
        if (process.env.TEST_FAULT === 'exception') setTimeout(() => { throw new Error('synthetic-private-token-body'); }, 10);
        return result;
      };`);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, TEST_FAULT: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', interrupted = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic entry timed out')); }, 3_000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!interrupted && output.includes('mock_ready') && (mode === 'SIGINT' || mode === 'SIGTERM')) {
        interrupted = true; child.kill(mode);
      }
    });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

describe('executable bounded signal exit and sanitized late SDK failures', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('routes %s through shutdown and exits 130', async mode => {
    const result = await execute(mode);
    expect(result.code).toBe(130); expect(result.signal).toBeNull(); expect(result.output).toContain('mock_stopped');
  });
  it.each(['exception', 'rejection'] as const)('sanitizes late %s and exits 1 after shutdown', async mode => {
    const result = await execute(mode);
    expect(result.code).toBe(1); expect(result.output).toContain('Slack transport_error'); expect(result.output).toContain('mock_stopped');
    expect(result.output).not.toMatch(/synthetic-private|Error:|at Timeout/u);
  });
});
