import { describe, expect, it, vi } from 'vitest';
import { guardSlackToolOutput } from './tool-output.js';

describe('internal Slack runtime output serialization guard', () => {
  it.each(['slack_read_attachment', 'slack_analyze_image', 'slack_read_channel', 'slack_search'])('blocks cycle/BigInt/undefined for %s without raw errors or private values', name => {
    const cycle: Record<string, unknown> = { private: 'PRIVATE_PROVIDER_BODY' }; cycle.self = cycle;
    for (const value of [cycle, { private: 'PRIVATE_PROVIDER_BODY', count: 1n }, undefined]) {
      const result = guardSlackToolOutput(name, value, ['CONFIG_SECRET']);
      expect(result).toMatchObject(name === 'slack_read_attachment' || name === 'slack_analyze_image'
        ? { ok: false, error: { code: 'PRIVATE_OUTPUT_BLOCKED' } } : { status: 'unavailable', complete: false, messages: [] });
      const encoded = JSON.stringify(result);
      expect(encoded).not.toMatch(/PRIVATE_PROVIDER_BODY|CONFIG_SECRET|BigInt|circular|TypeError/u);
    }
  });
  it('handles throwing/undefined toJSON and returns the inspected inert snapshot without invoking provider code twice', () => {
    const throwing = { toJSON() { throw new Error('PRIVATE_PROVIDER_BODY'); } };
    expect(guardSlackToolOutput('slack_read_attachment', throwing, [])).toMatchObject({ ok: false });
    expect(guardSlackToolOutput('slack_read_attachment', { toJSON: () => undefined }, [])).toMatchObject({ ok: false });
    const toJSON = vi.fn().mockReturnValueOnce({ ok: true, text: 'safe' }).mockReturnValueOnce({ text: 'CONFIG_SECRET' });
    const result = guardSlackToolOutput('slack_read_attachment', { toJSON }, ['CONFIG_SECRET']);
    expect(result).toEqual({ ok: true, text: 'safe' }); expect(JSON.stringify(result)).not.toContain('CONFIG_SECRET'); expect(toJSON).toHaveBeenCalledOnce();
  });
  it('retains secret/private URL blocking and safe JSON outputs', () => {
    for (const text of ['CONFIG_SECRET', 'https://files.slack.com/files-pri/T-F/private']) {
      expect(guardSlackToolOutput('slack_read_attachment', { ok: true, text }, ['CONFIG_SECRET'])).toMatchObject({ ok: false });
    }
    expect(guardSlackToolOutput('slack_read_channel', { status: 'ok', messages: [], complete: true }, [])).toEqual({ status: 'ok', messages: [], complete: true });
  });
});
