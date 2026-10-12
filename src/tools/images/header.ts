import { IMAGE_LIMITS as L, ImageError, imageMime, type ImageMime } from './policy.js';

export type ImageHeader = { mime: ImageMime; width: number; height: number };
const invalid = (): never => { throw new ImageError('INVALID_IMAGE'); };
function byte(data: Buffer, index: number): number {
  return data[index] ?? invalid();
}
function dimensions(width: number, height: number) {
  if (!width || !height) invalid();
  if (width > L.side || height > L.side || width * height > L.pixels) throw new ImageError('IMAGE_LIMIT');
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(bytes: Buffer): ImageHeader {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8, steps = 0, width = 0, height = 0, color = -1, depth = 0;
  let palette = false, idat = false, endedIdat = false, compressedBytes = 0;
  const zlibPrefix: number[] = [];
  while (offset < bytes.length) {
    if (++steps > L.headerSteps) throw new ImageError('IMAGE_LIMIT');
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2]!.toUpperCase()) invalid();
    if (crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    const data = bytes.subarray(offset + 8, end - 4);
    if (steps === 1 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (steps !== 1 || length !== 13) invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); dimensions(width, height);
      depth = byte(data, 8); color = byte(data, 9);
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || byte(data, 12) > 1) invalid();
    } else if (type === 'PLTE') {
      if (palette || idat || [0, 4].includes(color) || !length || length % 3 || length > 768 ||
          (color === 3 && length / 3 > 2 ** depth)) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (endedIdat || (color === 3 && !palette)) invalid();
      idat = true; compressedBytes += length;
      for (const byte of data.subarray(0, 2 - zlibPrefix.length)) zlibPrefix.push(byte);
    } else if (type === 'IEND') {
      if (length || !idat || compressedBytes < 6 || end !== bytes.length) invalid();
      const cmf = zlibPrefix[0] ?? invalid(), flg = zlibPrefix[1] ?? invalid();
      if ((cmf & 15) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) + flg) % 31 || (flg & 32)) invalid();
      return { mime: 'image/png', width, height };
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new ImageError('UNSUPPORTED_IMAGE');
      if (type[0] === type[0]!.toUpperCase()) invalid(); // unknown critical chunk
      if (idat) endedIdat = true;
    }
    offset = end;
  }
  return invalid();
}
function jpeg(bytes: Buffer): ImageHeader {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2, steps = 0, width = 0, height = 0, scanned = false, frameMarker = 0;
  const components = new Set<number>(); const seenComponents = new Set<number>(); const quant = new Set<number>();
  const tables = new Set<number>(); const componentQuant = new Map<number, number>();
  while (offset < bytes.length) {
    if (++steps > L.headerSteps) throw new ImageError('IMAGE_LIMIT');
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) { if (++offset >= bytes.length) invalid(); }
    const marker = byte(bytes, offset++);
    if (marker === 0xd9) {
      if (!scanned || !width || seenComponents.size !== components.size || offset !== bytes.length) invalid();
      return { mime: 'image/jpeg', width, height };
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    const data = bytes.subarray(offset + 2, end);
    if (marker === 0xc0 || marker === 0xc2) {
      if (width || data.length < 6 || data[0] !== 8 || ![1, 3].includes(byte(data, 5)) || data.length !== 6 + 3 * byte(data, 5)) invalid();
      height = data.readUInt16BE(1); width = data.readUInt16BE(3); dimensions(width, height); frameMarker = marker;
      for (let i = 6; i < data.length; i += 3) {
        const id = byte(data, i), sampling = byte(data, i + 1), q = byte(data, i + 2);
        if (components.has(id) || !(sampling >> 4) || !(sampling & 15) ||
            (sampling >> 4) > 4 || (sampling & 15) > 4 || q > 3) invalid();
        components.add(id); componentQuant.set(id, q);
      }
    } else if (marker === 0xdb) {
      let i = 0;
      while (i < data.length) {
        const spec = byte(data, i++); if ((spec >> 4) > 1 || (spec & 15) > 3) invalid();
        const size = (spec >> 4) ? 128 : 64;
        if (i + size > data.length) invalid();
        for (let j = i; j < i + size; j += (spec >> 4) ? 2 : 1) {
          if ((spec >> 4) ? data.readUInt16BE(j) === 0 : data[j] === 0) invalid();
        }
        quant.add(spec & 15); i += size;
      }
      if (!data.length) invalid();
    } else if (marker === 0xc4) {
      let i = 0;
      while (i < data.length) {
        const spec = byte(data, i++); if ((spec >> 4) > 1 || (spec & 15) > 3 || i + 16 > data.length) invalid();
        let count = 0, available = 1;
        for (let n = 0; n < 16; n++) { const c = byte(data, i++); count += c; available = available * 2 - c; if (available < 0) invalid(); }
        if (!count || count > 256 || i + count > data.length) invalid();
        tables.add(spec); i += count;
      }
      if (!data.length) invalid();
    } else if (marker === 0xda) {
      const n = byte(data, 0);
      if (!width || !n || n > components.size || data.length !== 1 + 2 * n + 3) invalid();
      const selected = new Set<number>();
      for (let i = 1; i <= 2 * n; i += 2) {
        const id = byte(data, i), spec = byte(data, i + 1);
        if (!components.has(id) || selected.has(id) || !quant.has(componentQuant.get(id)!) ||
            (spec >> 4) > 3 || (spec & 15) > 3) invalid();
        // Progressive AC/DC scans may reference only one table class.
        if (data.at(-3) === 0 && !tables.has(spec >> 4)) invalid();
        if (data.at(-2)! > 0 && !tables.has(16 + (spec & 15))) invalid();
        selected.add(id); seenComponents.add(id);
      }
      if (frameMarker === 0xc0 && (data.at(-3) !== 0 || data.at(-2) !== 63 || data.at(-1) !== 0)) invalid();
      if (frameMarker === 0xc2 && ((data.at(-3) === 0 && data.at(-2) !== 0) || (data.at(-3)! > 0 && n !== 1))) invalid();
      if (data.at(-3)! > data.at(-2)! || data.at(-2)! > 63 || (data.at(-1)! >> 4) > 13 || (data.at(-1)! & 15) > 13) invalid();
      offset = end; let entropy = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropy++; continue; }
        const start = offset++; while (bytes[offset] === 0xff) offset++;
        const next = byte(bytes, offset);
        if (next >= 0xd0 && next <= 0xd7 && ++steps > L.headerSteps) throw new ImageError('IMAGE_LIMIT');
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset++; entropy++; continue; }
        offset = start; break;
      }
      if (!entropy) invalid();
      scanned = true; continue;
    } else if (marker === 0xdd) {
      if (data.length !== 2) invalid();
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      // Unsupported arithmetic/lossless/extended frames, DNL, hierarchical modes.
      throw new ImageError('UNSUPPORTED_IMAGE');
    }
    offset = end;
  }
  return invalid();
}
/** Bounded structural preflight only. Never inflate, decode, render or execute image data. */
export function inspectImage(bytes: Buffer, declaredMime: string, downloadedMime: string): ImageHeader {
  if (!bytes.length) invalid();
  if (bytes.length > L.fileBytes) throw new ImageError('IMAGE_LIMIT');
  const mime = imageMime(declaredMime);
  if (imageMime(downloadedMime) !== mime) invalid();
  return mime === 'image/png' ? png(bytes) : jpeg(bytes);
}
