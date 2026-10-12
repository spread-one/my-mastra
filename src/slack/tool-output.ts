function blocked(name: string) {
  if (name === 'slack_read_attachment' || name === 'slack_analyze_image') return {
    ok: false, error: { code: 'PRIVATE_OUTPUT_BLOCKED', message: '안전하게 확인하지 못한 결과를 전달하지 않았습니다.' } };
  return { status: 'unavailable', message: '안전하게 확인하지 못한 결과를 전달하지 않았습니다.', messages: [],
    page: 0, nextCursor: null, complete: false, truncated: false, limits: { pageSize: 15, maxPages: 4, maxPageBytes: 24_000 } };
}

/** Internal runtime boundary: failed/undefined serialization never becomes a raw SDK error. */
export function guardSlackToolOutput(name: string, result: unknown, secrets: readonly string[]): unknown {
  try {
    const encoded = JSON.stringify(result);
    if (typeof encoded !== 'string' || secrets.some(secret => encoded.includes(secret) || encoded.includes(JSON.stringify(secret).slice(1, -1))) ||
        /https?:\/\/files\.slack\.com\/files-pri\//iu.test(encoded)) return blocked(name);
    // Return the inspected inert JSON snapshot, not a provider object with mutable getters/toJSON.
    return JSON.parse(encoded) as unknown;
  } catch { return blocked(name); }
}
