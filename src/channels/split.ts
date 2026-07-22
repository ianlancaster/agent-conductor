/**
 * Split text at paragraph, line, then code-point-safe hard boundaries.
 * Continuation chunks have leading whitespace trimmed.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (!Number.isInteger(maxLen) || maxLen < 1) throw new Error('maxLen must be a positive integer');
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) splitIdx = codePointBoundary(remaining, maxLen);
    if (splitIdx <= 0) throw new Error('maxLen is too small to hold the next Unicode code point');
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function codePointBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? index - 1 : index;
}
