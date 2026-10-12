import { describe, expect, it } from 'vitest';
import { loadSlackConfig } from './config.js';
import { ConfigError } from '../config.js';
const base = { DEEPSEEK_API_KEY: 'synthetic', SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic' };
const vision = { VISION_API_KEY: 'private-vision-key', VISION_BASE_URL: 'https://vision-provider.org/v1', VISION_MODEL: 'vision-model' };
describe('Slack explicit independent vision and private history configuration', () => {
  it('leaves image analysis unavailable with all absent; preserves keys and disk default', () => {
    expect(loadSlackConfig(base)).toMatchObject({ deepseekApiKey: 'synthetic', model: 'deepseek-chat', vision: undefined,
      historyPath: '.local/slack-history/history.sqlite' });
    expect(loadSlackConfig({ ...base, ...vision, SLACK_HISTORY_DB: '/private/history/history.sqlite' })).toMatchObject({ vision: {
      apiKey: vision.VISION_API_KEY, baseURL: vision.VISION_BASE_URL, model: vision.VISION_MODEL }, historyPath: '/private/history/history.sqlite' });
  });
  it.each([
    { VISION_API_KEY: vision.VISION_API_KEY }, { VISION_BASE_URL: vision.VISION_BASE_URL }, { VISION_MODEL: vision.VISION_MODEL },
    ...['http://vision-provider.org', 'https://127.0.0.1', 'https://private.local/v1', 'https://user:secret@vision-provider.org',
      'https://vision-provider.org/?secret=private', 'https://vision-provider.org:8443', 'https://vision-provider.org/unsafe'].map(VISION_BASE_URL => ({ ...vision, VISION_BASE_URL })),
    { ...vision, VISION_API_KEY: 'private\nkey' }, { ...vision, VISION_MODEL: 'private\nmodel' },
  ])('fails partial/unsafe config without echoing values %#', env => {
    try { loadSlackConfig({ ...base, ...env }); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toBe('VISION_API_KEY, VISION_BASE_URL, VISION_MODEL 설정을 확인하세요.');
      expect((error as Error).message).not.toContain('private');
    }
  });
});
