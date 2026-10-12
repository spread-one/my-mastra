import { ConfigError, loadConfig, type Config } from '../config.js';
import { publicUrl } from '../tools/web/network.js';
import { visionEndpoint, type VisionConfig } from '../tools/images/transport.js';
export interface SlackConfig extends Config { botToken: string; appToken: string; vision?: VisionConfig; historyPath?: string }

function loadVision(env: NodeJS.ProcessEnv): VisionConfig | undefined {
  const names = ['VISION_API_KEY', 'VISION_BASE_URL', 'VISION_MODEL'] as const;
  const values = names.map(name => env[name]?.trim() ?? '');
  if (values.every(value => !value)) return;
  if (values.some(value => !value || /[\x00-\x20]|your-|placeholder|changeme/iu.test(value))) {
    throw new ConfigError('VISION_API_KEY, VISION_BASE_URL, VISION_MODEL 설정을 확인하세요.');
  }
  const vision = { apiKey: values[0]!, baseURL: values[1]!, model: values[2]! };
  try { publicUrl(vision.baseURL); visionEndpoint(vision); }
  catch { throw new ConfigError('VISION_API_KEY, VISION_BASE_URL, VISION_MODEL 설정을 확인하세요.'); }
  return vision;
}

// Slack keys are required only in Slack mode; never read env on import.
export function loadSlackConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  const token = (name: string, prefix: string) => {
    const value = env[name]?.trim();
    if (!value || !new RegExp(`^${prefix}[A-Za-z0-9-]+$`, 'u').test(value) || /your-|example|placeholder/iu.test(value)) {
      throw new ConfigError(`${name}에 실제 ${prefix} 토큰을 설정하세요. .env.example을 참고하세요.`);
    }
    return value;
  };
  const execution = loadConfig(env);
  const historyPath = env.SLACK_HISTORY_DB?.trim();
  if (env.SLACK_HISTORY_DB !== undefined && (!historyPath || /[\x00-\x1f]/u.test(historyPath))) throw new ConfigError('SLACK_HISTORY_DB 설정을 확인하세요.');
  const botToken = token('SLACK_BOT_TOKEN', 'xoxb-'), appToken = token('SLACK_APP_TOKEN', 'xapp-'), vision = loadVision(env);
  if (vision && (vision.apiKey === botToken || vision.apiKey === appToken || /^(?:xox[baprs]-|xapp-)/u.test(vision.apiKey))) {
    throw new ConfigError('VISION_API_KEY, VISION_BASE_URL, VISION_MODEL 설정을 확인하세요.');
  }
  return { ...execution, botToken, appToken, vision, historyPath: historyPath ?? '.local/slack-history/history.sqlite' };
}
