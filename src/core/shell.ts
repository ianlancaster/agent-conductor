/** Single-quote a string for POSIX shells. Safe for any content. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
