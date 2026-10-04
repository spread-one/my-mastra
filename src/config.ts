export interface Config {
  deepseekApiKey: string;
  model: string;
  exaApiKey?: string;
}

export class ConfigError extends Error {}

function key(value: string | undefined, name: string, required: boolean): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (required) throw new ConfigError(`${name}가 필요합니다. .env.example을 참고해 로컬 .env에 설정하세요.`);
    return undefined;
  }
  if (/[\x00-\x20\x7f]/u.test(trimmed) || /^your-.*-api-key$/u.test(trimmed)) {
    throw new ConfigError(`${name}에 실제 API 키를 입력하세요. 공백·제어문자는 사용할 수 없습니다.`);
  }
  return trimmed;
}

// No environment reads or provider construction at import time.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deepseekApiKey = key(env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY', true)!;
  const exaApiKey = key(env.EXA_API_KEY, 'EXA_API_KEY', false);
  const model = env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(model)) {
    throw new ConfigError('DEEPSEEK_MODEL은 100자 이하의 모델 ID(영문·숫자·점·밑줄·하이픈)여야 합니다.');
  }
  return { deepseekApiKey, model, ...(exaApiKey ? { exaApiKey } : {}) };
}
