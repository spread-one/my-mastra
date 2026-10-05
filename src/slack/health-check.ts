import { checkHealth } from './health.js';
// Executable only; static health result, no HTTP listener or diagnostic payload output.
process.exitCode = checkHealth(process.env.SLACK_HEALTH_FILE ?? '/run/my-mastra/health.json') ? 0 : 1;
