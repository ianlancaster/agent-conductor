/** Global options that take a value, so their value is never mistaken for the subcommand. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '--dir', '--instance']);

/**
 * Make everything after `cmd` operator command-language text. Without this,
 * the CLI parser claims tokens such as `--session` or `--help` for itself.
 * Inserting `--` right after `cmd` is the parser's own end-of-options marker.
 */
export function withCmdPassthrough(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? '';
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  if (args[index] !== 'cmd' || args[index + 1] === '--') return [...args];
  return [...args.slice(0, index + 1), '--', ...args.slice(index + 1)];
}

/**
 * Rebuild one command line from shell tokens. A single token is already a
 * whole line. Otherwise a later token containing whitespace was quoted in the
 * shell, so it is re-quoted for the command language's double-quote rule.
 */
export function joinCommandLine(tokens: readonly string[]): string {
  if (tokens.length === 1) return tokens[0] ?? '';
  return tokens
    .map((token, index) => (index > 0 && /\s/u.test(token) && !token.includes('"') ? `"${token}"` : token))
    .join(' ');
}
