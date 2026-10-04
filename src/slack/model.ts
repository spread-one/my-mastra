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
    chat: async (messages, signal) => {
      const output = await agent.generate(messages, {
        instructions: instructions + '\n' + slackInstructions,
        maxSteps: 6, abortSignal: signal, modelSettings: { maxOutputTokens: 4_096, maxRetries: 0 },
      });
      if (!output.text.trim() || output.finishReason !== 'stop') throw new Error('SLACK_MODEL_INCOMPLETE');
      return output.text;
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
