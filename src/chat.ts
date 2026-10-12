import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import type { Config } from './config.js';
import { createMastra } from './mastra/index.js';

export type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };
export type ChatProgress = { toolCallId: string; toolName: string; state: 'in_progress' | 'complete' | 'error' };
export type ProgressObserver = (event: ChatProgress) => void | Promise<void>;
// Trusted host-only invocation metadata; never put this object into messages or history.
export type ChatRequestMetadata = Readonly<{ teamId: string; userId: string; channel: string; threadTs: string;
  requestId: string; actionToken?: unknown; requestContext?: RequestContext }>;
export type Chat = (messages: ChatMessage[], signal: AbortSignal, progress?: ProgressObserver, metadata?: ChatRequestMetadata) => Promise<string>;
export const CHAT_LIMITS = { promptChars: 8_000, replyChars: 20_000, historyChars: 48_000, turns: 12, deadlineMs: 90_000 } as const;

export function createChat(config: Config, options: Pick<NonNullable<Parameters<typeof createMastra>[0]>, 'model' | 'webOptions'> = {}): Chat {
  const agent = createMastra({ config, ...options, webOptions: { ...options.webOptions, enableContinuation: true } }).getAgent('main');
  // UUIDs are not Slack-shaped identities and cannot authorize any Slack read tool.
  const processId = randomUUID(), sessionId = randomUUID();
  return async (messages, signal) => {
    const requestContext = new RequestContext();
    for (const [key, value] of Object.entries({ teamId: `cli:${processId}`, userId: `cli:${sessionId}`,
      channel: `cli:${sessionId}`, threadTs: `cli:${sessionId}` })) requestContext.set(key, value);
    const output = await agent.generate(messages, {
      maxSteps: 6,
      requestContext, abortSignal: signal,
      modelSettings: { maxOutputTokens: 4_096, maxRetries: 0 },
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
