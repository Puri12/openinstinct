export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) {
    return "";
  }
  if (utf8Bytes(value) <= maximumBytes) {
    return value;
  }
  const ellipsis = "…";
  if (utf8Bytes(ellipsis) >= maximumBytes) {
    return "";
  }
  const limit = maximumBytes - utf8Bytes(ellipsis);
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (utf8Bytes(candidate) > limit) {
      break;
    }
    result = candidate;
  }
  return `${result}${ellipsis}`;
}
