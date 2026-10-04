import { config } from 'dotenv';
import { runCli } from './cli/run.js';

// Only this executable loads .env. Importing the library has no side effects.
config();
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  process.exitCode = await runCli({
    args: process.argv.slice(2),
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    interactive: Boolean(process.stdin.isTTY),
    signal: controller.signal,
  });
} catch {
  process.stderr.write('CLI 실행 중 오류가 발생했습니다. 입력과 환경 설정을 확인하세요.\n');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
