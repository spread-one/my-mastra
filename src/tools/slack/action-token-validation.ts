/** Trusted-event token acceptance rule. */
export function isUsableSlackActionToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0020]/.test(value);
}
