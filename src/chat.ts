import type { Config } from './config.js';
import { createMastra } from './mastra/index.js';

export type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };
export type Chat = (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
export const CHAT_LIMITS = { promptChars: 8_000, replyChars: 20_000, historyChars: 48_000, turns: 12, deadlineMs: 90_000 } as const;

export function createChat(config: Config): Chat {
  const agent = createMastra({ config }).getAgent('main');
  return async (messages, signal) => {
    const output = await agent.generate(messages, {
      maxSteps: 6,
      abortSignal: signal,
      modelSettings: { maxOutputTokens: 4_096 },
    });
    if (!output.text.trim()) throw new Error('EMPTY_REPLY');
    return output.text;
  };
}

// CLI-only, bounded process memory; never a Mastra Memory/storage provider.
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const bounded = messages.slice(-CHAT_LIMITS.turns * 2);
  let size = bounded.reduce((total, message) => total + message.content.length, 0);
  while (size > CHAT_LIMITS.historyChars && bounded.length > 2) {
    size -= bounded.shift()!.content.length + bounded.shift()!.content.length;
  }
  return bounded;
}
