import { guardSlackToolOutput } from './tool-output.js';
import type { ExtraTools } from '../agent/agents/main/index.js';
import { types } from 'node:util';
import type { DownloadDependencies } from '../tools/attachments/download.js';
import type { VisionDependencies } from '../tools/images/transport.js';
import { createAttachmentTools } from '../tools/attachments/tools.js';
import { AttachmentError, validateFileMetadata, type AuthorizeAttachment, type AttachmentMetadata } from '../tools/attachments/policy.js';
import { createImageTools } from '../tools/images/tools.js';
import { createSlackTools, authorizeCurrentSlackChannel, readAuthorizedSlackMessage, type SlackReadClient } from '../tools/slack/index.js';
import { getSlackSearchActionToken } from '../tools/slack/context.js';
import { scopedSlackClient } from '../tools/slack/transport.js';
import { checkAuthorization, errorResult } from '../tools/slack/errors.js';
import type { SlackConfig } from './config.js';

/** Snapshot own primitive metadata only. No getters/coercion or raw SDK records escape. */
function metadata(raw: unknown): AttachmentMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || types.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new AttachmentError('ACCESS_DENIED');
  const get = (key: string) => {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (d && !('value' in d)) throw new AttachmentError('ACCESS_DENIED');
    return d?.value as unknown;
  };
  const id = get('id'), name = get('name'), mimetype = get('mimetype'), size = get('size'), url = get('url_private_download');
  const mode = get('mode'), external = get('is_external');
  if (typeof id !== 'string' || !/^F[A-Z0-9]{1,63}$/u.test(id) || typeof name !== 'string' ||
      typeof mimetype !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
      typeof url !== 'string' || (mode !== undefined && typeof mode !== 'string') ||
      (external !== undefined && typeof external !== 'boolean')) throw new AttachmentError('ACCESS_DENIED');
  const file = { id, name, mimetype, size, url_private_download: url,
    ...(mode !== undefined ? { mode } : {}), ...(external !== undefined ? { is_external: external } : {}) };
  validateFileMetadata(file);
  return Object.freeze(file);
}

export function createSlackAttachmentAuthorization(base: SlackReadClient): AuthorizeAttachment {
  return async (fileId, messageTs, context, threadTs, signal) => {
    try {
      signal?.throwIfAborted();
      // ONE operation-local wrapper, deadline and call budget across all revalidations.
      const client = scopedSlackClient(base, context);
      const before = await authorizeCurrentSlackChannel(client, context);
      const message = await readAuthorizedSlackMessage(client, context, { messageTs, threadTs });
      if (message.channelId !== before.channelId || !message.fileIds.includes(fileId) || !client.apiCall) throw new AttachmentError('ACCESS_DENIED');
      const response = await client.apiCall('files.info', { file: fileId });
      checkAuthorization(response);
      const file = metadata((response as { file?: unknown }).file);
      if (file.id !== fileId) throw new AttachmentError('ACCESS_DENIED');
      // Immediately before returning to the downloader: fresh access AND message membership.
      const current = await readAuthorizedSlackMessage(client, context, { messageTs, threadTs });
      const after = await authorizeCurrentSlackChannel(client, context);
      signal?.throwIfAborted();
      const { channelName: _beforeName, ...beforeAuthority } = before;
      const { channelName: _afterName, ...afterAuthority } = after;
      if (JSON.stringify(beforeAuthority) !== JSON.stringify(afterAuthority) || current.channelId !== before.channelId ||
          !current.fileIds.includes(fileId)) throw new AttachmentError('ACCESS_DENIED');
      return { file, channelId: current.channelId, messageTs: current.messageTs };
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      const result = errorResult(error);
      throw new AttachmentError(result.status === 'rate_limited' ? 'RATE_LIMIT' : 'ACCESS_DENIED', result.retryAfterSeconds);
    }
  };
}

export type SlackToolTransportOptions = { downloadDependencies?: DownloadDependencies; visionDependencies?: VisionDependencies };
export function createSlackRuntimeTools(config: SlackConfig, client: SlackReadClient, transport: SlackToolTransportOptions = {}): ExtraTools {
  const authorize = createSlackAttachmentAuthorization(client);
  // Trusted installed dependency path, never a tool argument. Missing package fails explicitly.
  let pdfModuleURL: string | undefined;
  try { pdfModuleURL = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'); } catch { /* PDF_UNAVAILABLE */ }
  const displaySecrets = [config.botToken, config.appToken, config.deepseekApiKey, config.exaApiKey, config.vision?.apiKey].filter((s): s is string => !!s);
  const tools: ExtraTools = { ...createSlackTools(client, displaySecrets),
    ...createAttachmentTools({ authorize, botToken: config.botToken, parserOptions: { pdfModuleURL }, downloadDependencies: transport.downloadDependencies }),
    ...createImageTools({ authorize, botToken: config.botToken, vision: config.vision, downloadDependencies: transport.downloadDependencies, visionDependencies: transport.visionDependencies }) };
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) continue;
    tool.execute = async (input, context) => {
      const result = await execute(input, context);
      const secrets = [config.botToken, config.appToken, config.deepseekApiKey, config.exaApiKey, config.vision?.apiKey,
        getSlackSearchActionToken(context?.requestContext)].filter((s): s is string => !!s);
      return guardSlackToolOutput(name, result, secrets);
    };
  }
  return tools;
}
