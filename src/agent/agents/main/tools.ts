import { createWebTools } from '../../../tools/web/tools.js';

export const createMainTools = createWebTools;
export type WebOptions = Parameters<typeof createWebTools>[0];
