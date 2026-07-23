/** True for terminal control characters, including the Unicode C1 range. */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}
