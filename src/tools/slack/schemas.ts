import { z } from "zod";

export const channelId = z.string().regex(/^[CGD][A-Z0-9]{1,63}$/);
export const publicChannelId = z.string().regex(/^C[A-Z0-9]{1,63}$/);
export const slackTs = z.string().regex(/^[0-9]{1,16}\.[0-9]{6}$/);
export const channelInput = z.object({
  channel: channelId.optional().describe("생략하면 현재 요청 채널. 다른 채널은 허용하지 않습니다."),
  cursor: z.string().min(1).max(128).optional().describe("이 도구가 반환한 불투명 nextCursor만 사용"),
}).strict();
export const threadInput = z.object({
  channel: channelId.optional().describe("생략하면 현재 채널. 다른 채널은 같은 workspace의 비공유 공개 채널만, 요청자 membership과 bot 읽기 권한 필요"),
  cursor: z.string().min(1).max(128).optional().describe("반환된 불투명 nextCursor를 그대로 복사; 재구성/placeholder 금지"),
  ts: slackTs.optional().describe("부모 메시지 ts (소수점 이하 정확히 6자리)"),
  url: z.string().max(512).optional().describe("현재 workspace Slack 메시지 permalink; HTTP 요청하지 않음"),
}).strict();
export const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  channel: publicChannelId.optional().describe("생략하면 workspace 공개 채널 검색. 지정하면 해당 비공유 공개 채널만 검색"),
  cursor: z.string().min(1).max(128).optional().describe("반환된 불투명 nextCursor를 그대로 복사; 재구성/placeholder 금지"),
  limit: z.number().int().min(1).max(20).default(20),
}).strict();

// Display-only metadata from live conversations.info; never an address or permission.
export const verifiedChannelName = z.string().min(1).max(80)
  .refine(name => name.length <= 80 && name === name.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(name));

export const readOutput = z.object({
  status: z.enum(["ok", "invalid_target", "access_denied", "unsupported", "rate_limited", "unavailable"]),
  message: z.string(),
  source: z.object({ channel: z.string(), channelName: verifiedChannelName.optional(), threadTs: z.string().optional() }).optional(),
  messages: z.array(z.object({
    channel: z.string(), channelName: verifiedChannelName.optional(), ts: z.string(), threadTs: z.string().optional(),
    author: z.object({ userId: z.string().nullable(), botId: z.string().nullable(), kind: z.enum(["participant", "bot", "system"]) }),
    text: z.string(), textTruncated: z.boolean(), replyCount: z.number().int().nonnegative().optional(),
    permalink: z.string().optional(), searchMatch: z.boolean().optional(),
    contextForTs: z.string().optional(), contextPosition: z.enum(["before", "after"]).optional(),
  })),
  api: z.literal("assistant.search.context").optional(),
  searchScope: z.enum(["workspace_public", "channel"]).optional(),
  page: z.number().int(), nextCursor: z.string().nullable(),
  complete: z.boolean(), truncated: z.boolean(),
  retryAfterSeconds: z.number().optional(),
  limits: z.object({ pageSize: z.number(), maxPages: z.number(), maxPageBytes: z.number() }),
});
export type ReadResult = z.infer<typeof readOutput>;
