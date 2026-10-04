import { ConfigError, loadConfig, type Config } from '../config.js';
export interface SlackConfig extends Config { botToken: string; appToken: string }

// Slack keys are required only in Slack mode; never read env on import.
export function loadSlackConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  const token = (name: string, prefix: string) => {
    const value = env[name]?.trim();
    if (!value || !new RegExp(`^${prefix}[A-Za-z0-9-]+$`, 'u').test(value) || /your-|example|placeholder/iu.test(value)) {
      throw new ConfigError(`${name}에 실제 ${prefix} 토큰을 설정하세요. .env.example을 참고하세요.`);
    }
    return value;
  };
  return { ...loadConfig(env), botToken: token('SLACK_BOT_TOKEN', 'xoxb-'), appToken: token('SLACK_APP_TOKEN', 'xapp-') };
}
