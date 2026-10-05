import { config } from 'dotenv';
import { runSlack } from './slack/run.js';

// Only this executable loads .env; importing transport/model/config has no env side effects.
config();
const controller = new AbortController();
let fatal = false;
// A late SDK reconnect failure must not trigger Node's default raw Error/payload logging.
// Executable-only last resort: abort through the normal bounded shutdown path.
const transportFailure = () => {
  if (!fatal) process.stderr.write('Slack transport_error\n');
  fatal = true;
  controller.abort();
};
process.on('uncaughtException', transportFailure);
process.on('unhandledRejection', transportFailure);
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
  process.removeListener('uncaughtException', transportFailure);
  process.removeListener('unhandledRejection', transportFailure);
  // Socket Mode/SDK sockets or non-cooperative dependencies must not keep a stopped process alive.
  // This is an executable-only exit, not a library import side effect.
  process.exit(fatal ? 1 : process.exitCode ?? 0);
}
