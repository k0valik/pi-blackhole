/** Split a shell command string into tokens, preserving quoted strings. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i];
    } else if (ch === "'") {
      current += ch;
      inSingle = true;
    } else if (ch === '"') {
      current += ch;
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Split a command string at the first unquoted pipe or redirect boundary.
 *
 * Shell operators: |  2>  >>  1>&2  <  &&  ||  ;
 * We split on any of these that appear outside quotes.
 *
 * Returns [before, atAndAfter] or null if none found.
 */
export function splitShellBoundary(str: string): [string, string] | null {
  // Match shell operators: |  ||  &&  ;  >  >>  2>  1>&2  <  etc.
  // Anchored with ^ so match is O(1) per character, not O(N).
  const pattern = /^(?:&&|\|\||[|&;<>]|(?:[12]?>>?[&]?[12]?))/;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && i + 1 < str.length) i++;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "\\" && i + 1 < str.length) {
      // Outside quotes: backslash escapes the next character
      i++;
    } else {
      const rest = str.slice(i);
      const m = rest.match(pattern);
      if (m) {
        return [str.slice(0, i).trimEnd(), str.slice(i)];
      }
    }
  }
  return null;
}

/**
 * Wrap a string in single quotes for safe shell passthrough.
 * Already-quoted strings (single or double) are left as-is.
 * Values without shell metacharacters are returned unchanged.
 */
const SHELL_META = /[\s{}()$`!'"\\|&;<>#*?[\]~]/;
export function shellQuote(value: string): string {
  // Already-quoted single: pass through only if no internal quotes break it
  if (value.startsWith("'") && value.endsWith("'") && !value.slice(1, -1).includes("'")) {
    return value;
  }
  // Already-quoted double: pass through only if no internal quotes or expansion chars
  if (
    value.startsWith('"') &&
    value.endsWith('"') &&
    !value.slice(1, -1).includes('"') &&
    !/[\\$`]/.test(value.slice(1, -1))
  ) {
    return value;
  }
  // No shell metacharacters - safe to pass through unchanged
  if (!SHELL_META.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Strip surrounding shell quotes from a string. */
export function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
