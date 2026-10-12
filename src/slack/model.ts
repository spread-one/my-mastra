import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText } from 'ai';
import { createMastra } from '../mastra/index.js';
import { instructions } from '../agent/agents/main/instructions.js';
import type { Config } from '../config.js';
import type { Chat } from '../chat.js';
import { slackInstructions, summaryInstructions } from './instructions.js';
import { summaryInput, type Summarize } from './context.js';

export function createSlackModels(config: Config): { chat: Chat; summarize: Summarize } {
  const model = createDeepSeek({ apiKey: config.deepseekApiKey })(config.model);
  // Reuse the existing no-logger/no-memory registration rather than a default-logger standalone Agent.
  const agent = createMastra({ config, model }).getAgent('main');
  return {
    chat: async (messages, signal, progress) => {
      const output = await agent.stream(messages, {
        instructions: instructions + '\n' + slackInstructions,
        maxSteps: 6, abortSignal: signal, modelSettings: { maxOutputTokens: 4_096, maxRetries: 0 },
      });
      const reader = output.fullStream.getReader();
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          if (value.type === 'error') throw new Error('SLACK_MODEL_INCOMPLETE');
          if (value.type === 'tool-call' || value.type === 'tool-result' || value.type === 'tool-error' || value.type === 'tool-output-denied') {
            const payload = value.payload;
            try { await progress?.({ toolCallId: payload.toolCallId, toolName: payload.toolName,
              state: value.type === 'tool-call' ? 'in_progress' : (value.type === 'tool-error' || value.type === 'tool-output-denied' || ('isError' in payload && payload.isError) ? 'error' : 'complete') }); }
            catch { signal.throwIfAborted(); } // Ancillary UI failure never reruns the model.
          }
        }
      } finally { reader.releaseLock(); }
      const [text, finishReason] = await Promise.all([output.text, output.finishReason]);
      signal.throwIfAborted();
      if (!text.trim() || finishReason !== 'stop') throw new Error('SLACK_MODEL_INCOMPLETE');
      return text;
    },
    summarize: async (messages, maxBytes, signal) => {
      const output = await generateText({ model, system: summaryInstructions,
        messages: [{ role: 'user', content: summaryInput(messages, maxBytes) }],
        maxOutputTokens: 1_500, maxRetries: 0, abortSignal: signal });
      if (output.finishReason !== 'stop') throw new Error('SLACK_SUMMARY_INCOMPLETE');
      return output.text;
    },
  };
}
