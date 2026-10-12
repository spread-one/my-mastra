import { describe, expect, it } from 'vitest';
import { inspectImage } from './header.js';
import { IMAGE_LIMITS as L, ImageError } from './policy.js';
import { jpegFixture, jpegSegment, pngChunk, pngFixture } from './fixtures.test-helper.js';

describe('bounded PNG/JPEG structural preflight (no inflate/decode)', () => {
  it('accepts PNG, baseline and progressive JPEG with actual matching MIME', () => {
    expect(inspectImage(pngFixture(), 'image/png', 'IMAGE/PNG')).toEqual({ mime: 'image/png', width: 1, height: 1 });
    for (const progressive of [false, true]) expect(inspectImage(jpegFixture(40, 30, progressive), 'image/jpeg', 'image/jpeg'))
      .toEqual({ mime: 'image/jpeg', width: 40, height: 30 });
  });
  it('rejects all truncated containers, signature/MIME mismatch, trailing data and empty files', () => {
    for (const [image, mime] of [[pngFixture(), 'image/png'], [jpegFixture(), 'image/jpeg']] as const) {
      for (let end = 0; end < image.length; end++) expect(() => inspectImage(image.subarray(0, end), mime, mime)).toThrow(ImageError);
      expect(() => inspectImage(Buffer.concat([image, Buffer.from([0])]), mime, mime)).toThrow(ImageError);
    }
    for (const [image, declared, downloaded] of [
      [pngFixture(), 'image/jpeg', 'image/jpeg'], [jpegFixture(), 'image/png', 'image/png'],
      [pngFixture(), 'image/png', 'image/jpeg'], [pngFixture(), 'image/webp', 'image/png'],
      [Buffer.from('GIF89a'), 'image/gif', 'image/gif'], [pngFixture(), 'image/png', 'application/octet-stream'],
    ] as const) expect(() => inspectImage(image, declared, downloaded)).toThrow(ImageError);
  });
  it('rejects file, dimension, pixel, zero-dimension and bounded-iteration violations', () => {
    expect(() => inspectImage(Buffer.alloc(L.fileBytes + 1), 'image/png', 'image/png')).toThrow('IMAGE_LIMIT');
    for (const [width, height] of [[8193, 1], [4001, 4000], [65535, 65535]]) {
      for (const [bytes, mime] of [[pngFixture(width, height), 'image/png'], [jpegFixture(width, height), 'image/jpeg']] as const)
        expect(() => inspectImage(bytes, mime, mime)).toThrow('IMAGE_LIMIT');
    }
    for (const image of [pngFixture(0, 1), jpegFixture(1, 0)]) expect(() => inspectImage(image,
      image[1] === 216 ? 'image/jpeg' : 'image/png', image[1] === 216 ? 'image/jpeg' : 'image/png')).toThrow('INVALID_IMAGE');
    expect(inspectImage(pngFixture(4000, 4000), 'image/png', 'image/png').width).toBe(4000);
    expect(inspectImage(pngFixture(8192, 1), 'image/png', 'image/png').width).toBe(8192);
    const repeated = Array.from({ length: L.headerSteps }, () => pngChunk('tEXt', Buffer.alloc(0)));
    expect(() => inspectImage(pngFixture(1, 1, repeated), 'image/png', 'image/png')).toThrow('IMAGE_LIMIT');
  });
  it('rejects PNG CRC, chunk lengths, IHDR, unknown critical chunks and animation', () => {
    const brokenCrc = pngFixture(); brokenCrc[32] = brokenCrc[32]! ^ 1;
    const brokenSize = pngFixture(); brokenSize.writeUInt32BE(0xffffffff, 8);
    for (const image of [brokenCrc, brokenSize, pngFixture(1, 1, [pngChunk('ABCD', Buffer.alloc(0))]),
      pngFixture(1, 1, [pngChunk('IHDR', Buffer.alloc(13))])])
      expect(() => inspectImage(image, 'image/png', 'image/png')).toThrow('INVALID_IMAGE');
    expect(() => inspectImage(pngFixture(1, 1, [pngChunk('acTL', Buffer.alloc(8))]), 'image/png', 'image/png')).toThrow('UNSUPPORTED_IMAGE');
    const raw = pngFixture(); const badHeader = Buffer.from(raw.subarray(16, 29)); badHeader[8] = 3;
    const image = Buffer.concat([raw.subarray(0, 8), pngChunk('IHDR', badHeader), raw.subarray(33)]);
    expect(() => inspectImage(image, 'image/png', 'image/png')).toThrow('INVALID_IMAGE');
  });
  it('rejects malformed JPEG segment bounds, tables, scan structure, unsupported frame and missing EOI', () => {
    const raw = jpegFixture(); const oversized = Buffer.from(raw); oversized.writeUInt16BE(65535, 4);
    const zeroQuant = Buffer.from(raw); zeroQuant[7] = 0;
    const noFrame = Buffer.concat([raw.subarray(0, 71), raw.subarray(84)]);
    const unsupported = Buffer.from(raw); unsupported[72] = 0xc3;
    for (const image of [oversized, zeroQuant, noFrame, raw.subarray(0, -2)])
      expect(() => inspectImage(image, 'image/jpeg', 'image/jpeg')).toThrow(ImageError);
    expect(() => inspectImage(unsupported, 'image/jpeg', 'image/jpeg')).toThrow('UNSUPPORTED_IMAGE');
    const segments = Array.from({ length: L.headerSteps }, () => jpegSegment(0xfe, Buffer.alloc(0)));
    expect(() => inspectImage(Buffer.concat([raw.subarray(0, 2), ...segments, raw.subarray(2)]), 'image/jpeg', 'image/jpeg')).toThrow('IMAGE_LIMIT');
  });
  it('counts entropy restart markers against the same 4096-step JPEG budget', () => {
    const raw = jpegFixture();
    const withRestarts = (count: number) => {
      const markers = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) { markers[2 * i] = 0xff; markers[2 * i + 1] = 0xd0 + i % 8; }
      return Buffer.concat([raw.subarray(0, -2), markers, raw.subarray(-2)]);
    };
    // Structural preflight only: accepting this does not guarantee valid decoded pixels/restart order.
    expect(inspectImage(withRestarts(16), 'image/jpeg', 'image/jpeg')).toMatchObject({ width: 1, height: 1 });
    const overBudget = withRestarts(5000);
    expect(overBudget.length).toBeLessThan(L.fileBytes);
    expect(() => inspectImage(overBudget, 'image/jpeg', 'image/jpeg')).toThrow('IMAGE_LIMIT');
  });
  it('fails closed on deterministic random inputs without native parser errors', () => {
    let seed = 1;
    for (let n = 0; n < 100; n++) {
      const bytes = Buffer.alloc(n); for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; bytes[i] = seed & 255; }
      for (const mime of ['image/png', 'image/jpeg']) {
        try { inspectImage(bytes, mime, mime); throw new Error('unexpected success'); } catch (error) { expect(error).toBeInstanceOf(ImageError); }
      }
    }
  });
});
