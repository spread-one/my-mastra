import { config } from 'dotenv';
import { runSlack } from './slack/run.js';

// Only this executable loads .env; importing transport/model/config has no env side effects.
config();
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  process.exitCode = await runSlack({ args: process.argv.slice(2), output: process.stdout,
    error: process.stderr, signal: controller.signal });
} catch {
  process.stderr.write('Slack 실행 중 오류가 발생했습니다. 설정을 확인하세요.\n');
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  // Socket Mode/SDK sockets or non-cooperative dependencies must not keep a stopped process alive.
  // This is an executable-only exit, not a library import side effect.
  process.exit(process.exitCode ?? 0);
}
