import { deflateSync } from 'node:zlib';
/** Synthetic containers for header tests, not proof that a remote vision model decoded them. */
export function pngChunk(type: string, data: Buffer) {
  const tagged = Buffer.concat([Buffer.from(type), data]); let c = 0xffffffff;
  for (const b of tagged) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, tagged, checksum]);
}
export function pngFixture(width = 1, height = 1, middle: Buffer[] = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), ...middle,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))]);
}
export function jpegSegment(marker: number, data: Buffer) {
  const prefix = Buffer.from([255, marker, 0, 0]); prefix.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([prefix, data]);
}
export function jpegFixture(width = 1, height = 1, progressive = false) {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3);
  const table = (spec: number) => Buffer.from([spec, 1, ...Array(15).fill(0), 0]);
  return Buffer.concat([Buffer.from([255, 216]), jpegSegment(0xdb, Buffer.from([0, ...Array(64).fill(1)])),
    jpegSegment(progressive ? 0xc2 : 0xc0, frame), jpegSegment(0xc4, Buffer.concat([table(0), table(16)])),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, progressive ? 0 : 63, 0])), Buffer.from([0x3f, 255, 217])]);
}
export function visionResponse(text = '빨간 점으로 보입니다. 작은 글자는 확실하지 않습니다.', finish = 'stop') {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: finish }] });
}
