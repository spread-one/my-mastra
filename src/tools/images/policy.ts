import { AttachmentError, failure as attachmentFailure } from '../attachments/policy.js';

export const IMAGE_LIMITS = Object.freeze({ fileBytes: 4 * 1024 * 1024, side: 8192,
  pixels: 16_000_000, headerSteps: 4096, questionChars: 1000, requestBytes: 6 * 1024 * 1024,
  responseBytes: 64 * 1024, outputBytes: 16 * 1024, deadlineMs: 30_000, maxTokens: 2048 });
export type ImageMime = 'image/png' | 'image/jpeg';
export type ImageCode = 'UNSUPPORTED_IMAGE' | 'INVALID_IMAGE' | 'IMAGE_LIMIT' | 'INVALID_INPUT' |
  'VISION_CONFIG' | 'VISION_FAILED' | 'VISION_RESPONSE_LIMIT' | 'CANCELLED';
export class ImageError extends Error {
  constructor(public readonly code: ImageCode) { super(code); }
}
export function imageMime(value: string): ImageMime {
  const type = value.split(';')[0]!.trim().toLowerCase();
  if (type !== 'image/png' && type !== 'image/jpeg') throw new ImageError('UNSUPPORTED_IMAGE');
  return type;
}
export function imageFailure(error: unknown) {
  if (error instanceof AttachmentError && error.code === 'UNSUPPORTED_TYPE') error = new ImageError('UNSUPPORTED_IMAGE');
  if (error instanceof AttachmentError) {
    const result = attachmentFailure(error);
    return { ...result, limits: IMAGE_LIMITS };
  }
  const code = error instanceof ImageError ? error.code : 'VISION_FAILED';
  const messages: Record<ImageCode, string> = {
    UNSUPPORTED_IMAGE: 'PNG·JPEG 첨부만 지원합니다. GIF·WebP·영상·외부 이미지 URL·스캔 PDF는 지원하지 않습니다.',
    INVALID_IMAGE: '이미지 MIME·서명·헤더 구조가 일치하지 않거나 손상되었습니다.',
    IMAGE_LIMIT: '이미지는 최대 4 MiB, 한 변 8192 픽셀, 총 1600만 픽셀 이내여야 합니다.',
    INVALID_INPUT: '현재 메시지의 fileId·messageTs와 짧은 분석 요청을 확인해 주세요.',
    VISION_CONFIG: '현재 이미지 분석 연결 설정을 사용할 수 없습니다. 운영자에게 확인을 요청해 주세요.',
    VISION_FAILED: '이미지 분석 API가 실패했거나 이미지 입력을 지원하지 않습니다. 텍스트 분석으로 대체하지 않았습니다.',
    VISION_RESPONSE_LIMIT: '이미지 분석 응답이 안전한 크기 한도를 초과했습니다.',
    CANCELLED: '이미지 분석이 취소되었거나 제한 시간을 초과했습니다.',
  };
  return { ok: false as const, error: { code, message: messages[code] }, limits: IMAGE_LIMITS };
}
export function utf8Prefix(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ImageError('CANCELLED');
}
