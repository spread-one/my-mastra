import { deflateSync } from 'node:zlib';
/** Synthetic minimal PDF, never a credentialed Slack fixture. */
export function pdfFixture(pages: string[], options: { compressed?: boolean; encrypted?: boolean; scanned?: boolean; streamFilter?: string; streamExtras?: string } = {}) {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${options.scanned ? ` /XObject << /Im1 ${4 + pages.length * 2} 0 R >>` : ''} >> /Contents ${5 + i * 2} 0 R >>`);
    const content = Buffer.from(options.scanned ? 'q 200 0 0 200 72 400 cm /Im1 Do Q' : text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '');
    const stream = options.compressed ? deflateSync(content) : content;
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length}${options.compressed ? ` /Filter ${options.streamFilter ?? '/FlateDecode'}` : ''}${options.streamExtras ? ` ${options.streamExtras}` : ''} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  });
  if (options.scanned) {
    const image = deflateSync(Buffer.from([0, 0, 0]));
    add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} /Filter /FlateDecode >>\nstream\n`), image, Buffer.from('\nendstream')]));
  }
  let result = Buffer.from('%PDF-1.7\n'); const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(result.length); result = Buffer.concat([result, Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
  });
  const xref = result.length;
  return Buffer.concat([result, Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${offsets.length}${options.encrypted ? ' /Encrypt 99 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
