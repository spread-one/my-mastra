import { createDeepSeek } from '@ai-sdk/deepseek';
import type { AgentConfig } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createMainAgent } from '../agent/agents/main/index.js';
import type { WebOptions } from '../agent/agents/main/tools.js';
import { loadConfig, type Config } from '../config.js';

export function createMastra(options: { config?: Config; model?: AgentConfig['model']; webOptions?: WebOptions } = {}) {
  // A model can be injected for offline tests or programmatic use without keys.
  const config = options.config ?? (options.model ? undefined : loadConfig());
  const model = options.model ?? createDeepSeek({ apiKey: config!.deepseekApiKey })(config!.model);
  const main = createMainAgent(model, { exaApiKey: config?.exaApiKey, ...options.webOptions });
  return new Mastra({ agents: { main }, logger: false });
}
