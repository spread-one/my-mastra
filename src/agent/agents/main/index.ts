import { Agent, type AgentConfig } from '@mastra/core/agent';
import { instructions } from './instructions.js';
import { description } from './description.js';
import { createMainTools, type WebOptions } from './tools.js';

export function createMainAgent(model: AgentConfig['model'], webOptions: WebOptions = {}) {
  // Mastra ships optional usage telemetry as a transitive dependency. This standalone
  // public-web runtime must not send diagnostics to another service, even if a parent
  // process enabled them. This happens only on factory invocation, never on import.
  process.env.MASTRA_TELEMETRY_DISABLED = 'true';
  return new Agent({
    id: 'my-mastra',
    name: 'my-mastra',
    description,
    instructions,
    model,
    tools: createMainTools(webOptions),
  });
}
