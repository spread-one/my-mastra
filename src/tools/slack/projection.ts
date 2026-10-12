export function jsonTextPrefix(text: string, budget: number) {
  let output = "", used = 0;
  for (const char of text) {
    const n = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (used + n > budget) break;
    output += char; used += n;
  }
  return output;
}
