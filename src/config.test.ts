import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('explicit, secret-safe configuration', () => {
  it('requires only the chat key and defaults the model', () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: ' synthetic ' })).toEqual({ deepseekApiKey: 'synthetic', model: 'deepseek-chat' });
    expect(loadConfig({ DEEPSEEK_API_KEY: 'synthetic', DEEPSEEK_MODEL: 'deepseek-reasoner', EXA_API_KEY: ' optional ' })).toEqual({
      deepseekApiKey: 'synthetic', model: 'deepseek-reasoner', exaApiKey: 'optional',
    });
    expect(loadConfig({ DEEPSEEK_API_KEY: 'synthetic', EXA_API_KEY: '  ', DEEPSEEK_MODEL: ' ' }).exaApiKey).toBeUndefined();
  });
  it.each([undefined, '', ' ', 'your-deepseek-api-key'])('rejects missing or placeholder chat key: %s', (value) => {
    expect(() => loadConfig({ DEEPSEEK_API_KEY: value })).toThrow(/DEEPSEEK_API_KEY/u);
  });
  it('rejects malformed keys/models without echoing them', () => {
    for (const env of [
      { DEEPSEEK_API_KEY: 'synthetic\nsecret' },
      { DEEPSEEK_API_KEY: 'synthetic', EXA_API_KEY: 'secret key' },
      { DEEPSEEK_API_KEY: 'synthetic', DEEPSEEK_MODEL: 'secret/model' },
    ]) {
      try { loadConfig(env); expect.fail('expected validation failure'); }
      catch (error) { expect(String(error)).not.toMatch(/synthetic|secret/u); }
    }
  });
});
