import { RequestContext } from '@mastra/core/request-context';
import type { ChatRequestMetadata } from '../chat.js';
import { bindSlackReadContext } from '../tools/slack/index.js';

/** Host-only authenticated invocation bridge, shared by automatic reads and agent.stream. */
export function createSlackInvocationContext(metadata: ChatRequestMetadata, signal: AbortSignal): RequestContext {
  const requestContext = metadata.requestContext ?? new RequestContext();
  const { teamId, userId, channel, threadTs, requestId } = metadata;
  bindSlackReadContext(requestContext, { teamId, userId, channel, threadTs, requestId }, metadata.actionToken, signal);
  for (const [key, value] of Object.entries({ teamId, userId, channel, threadTs })) requestContext.set(key, value);
  return requestContext;
}
