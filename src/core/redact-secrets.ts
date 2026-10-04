/**
 * Mask credential values before transcript text is copied into derived
 * context: compaction summaries (VCC, OM render, append segments), memory lines
 * sent to the observer/reflector/dropper, and the observer's input chunk.
 * The raw session JSONL and `recall` are intentionally left untouched.
 *
 * Two layers:
 * 1. Vendor formats with a fixed prefix (high precision, no keyword needed).
 * 2. Generic tokens next to a credential keyword on the same line, or alone on
 *    the line under a `label:` ("<token> here is my apikey", "API_KEY=<token>",
 *    `"apiKey":\n  "<token>"`). Shape checks keep model ids, UUIDs, paths and
 *    identifiers out.
 */

const marker = (kind: string): string => `[REDACTED ${kind}]`;

// Vendor formats: the fixed prefix is enough evidence on its own.
const KNOWN_FORMATS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  [
    "private-key",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  ],
  // OpenAI / Anthropic / OpenRouter / DeepSeek and other `sk-` style keys.
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}/g],
  // Kaggle API token.
  ["api-key", /\bKGAT_[A-Za-z0-9]{20,}/g],
  ["token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["token", /\bhf_[A-Za-z0-9]{30,}/g],
  ["token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// scheme://user:password@host — keep everything except the password.
// The password may contain `/`; a numeric port followed by a path, query or
// fragment (`host:8080/a@b`, `host:8080?email=a@b`) is not userinfo.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]+:)([^\s@]+)@/gi;
const PORT_THEN_PATH = /^\d+[/?#]/;

const KEYWORD =
  /api[_\s-]?key|apikey|access[_\s-]?key|secret|token(?!s|iz)|passw(?:or)?d|\bpwd\b|credential|\bauth(?:orization|_?token)?\b|bearer|\bapi\b/i;
// Labels whose values are public identifiers or cursors, not credentials.
const NON_SECRET_LABEL = /(?:\bid|_id|page[_\s-]?token)["'`\s:=]*$/i;
const KEYWORD_WINDOW = 40;
// `/` is part of the base64 alphabet; path-shaped tokens are filtered by insidePathOrUrl.
const CANDIDATE = /[A-Za-z0-9_+/-]{20,}={0,2}/g;
const PURE_HEX_DIGEST = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/; // git SHA-1 / SHA-256 digests
// `api_key = <value>`: an explicit assignment overrides the digest exclusion (many keys are hex).
const ASSIGNED_TO_SECRET =
  /(?:api[_\s-]?key|apikey|secret|token|passw(?:or)?d|credential)["'`]?\s*[:=]\s*["'`]?$/i;

const digitCount = (s: string): number => s.replace(/[^0-9]/g, "").length;
const letterCount = (s: string): number => s.replace(/[^A-Za-z]/g, "").length;
// `sk-` also starts prose like "sk-learn-compatible"; real keys contain digits or capitals.
const isProse = (match: string): boolean =>
  match.startsWith("sk-") && !/[0-9A-Z]/.test(match.slice(3));

const entropy = (s: string): number => {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/** Random-looking: one long separator-free body mixing letters and digits. */
const looksRandom = (token: string, assigned: boolean): boolean => {
  if (!assigned && PURE_HEX_DIGEST.test(token)) return false;
  const body = token
    .replace(/=+$/, "")
    .split(/[-_]/)
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  // camelCase / snake identifiers are mostly lowercase word runs.
  const wordLetters = (body.match(/[a-z]{3,}/g) ?? []).join("").length;
  if (wordLetters / body.length >= 0.6 && digitCount(body) <= 4) return false;
  return body.length >= 16 && digitCount(body) >= 2 && letterCount(body) >= 2 && entropy(body) >= 3;
};

const insidePathOrUrl = (text: string, start: number, end: number): boolean => {
  const before = text[start - 1] ?? "";
  const after = text.slice(end, end + 2);
  if (/[/\\.@]/.test(before) || /^[/\\]/.test(after) || /^\.[A-Za-z]/.test(after)) return true;
  const token = text.slice(start, end);
  if (!token.includes("/")) return false;
  // Path segments are mostly lowercase words (`cache/models/...`); a base64 value
  // only rarely has one, so it takes at least half the segments to call it a path.
  const segments = token.split("/").filter(Boolean);
  const words = segments.filter((segment) => /^[a-z]{3,}[0-9]*$/.test(segment)).length;
  return words * 2 >= segments.length;
};

const nearKeyword = (text: string, start: number, end: number): boolean => {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  const lineEnd = nl === -1 ? text.length : nl;
  const before = text.slice(Math.max(lineStart, start - KEYWORD_WINDOW), start);
  if (NON_SECRET_LABEL.test(before)) return false;
  const after = text.slice(end, Math.min(lineEnd, end + KEYWORD_WINDOW));
  return KEYWORD.test(before) || KEYWORD.test(after);
};

// A value alone on its line under a label (`"apiKey":` / `password:` in pretty-printed
// JSON, YAML or .env pastes) counts as assigned to that label.
const labelOnPreviousLine = (text: string, start: number): boolean => {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (lineStart === 0 || !/^\s*["'`]?$/.test(text.slice(lineStart, start))) return false;
  const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
  const prev = text.slice(prevStart, lineStart - 1).trimEnd();
  return ASSIGNED_TO_SECRET.test(prev) && !NON_SECRET_LABEL.test(prev);
};

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [kind, pattern] of KNOWN_FORMATS) {
    out = out.replace(pattern, (match) => (isProse(match) ? match : marker(kind)));
  }
  out = out.replace(URL_PASSWORD, (match, prefix: string, password: string) =>
    PORT_THEN_PATH.test(password) ? match : `${prefix}${marker("password")}@`,
  );
  return out.replace(CANDIDATE, (token, offset: number, whole: string) => {
    const end = offset + token.length;
    const labelled = labelOnPreviousLine(whole, offset);
    const assigned =
      labelled ||
      ASSIGNED_TO_SECRET.test(whole.slice(Math.max(0, offset - KEYWORD_WINDOW), offset));
    if (!looksRandom(token, assigned)) return token;
    if (insidePathOrUrl(whole, offset, end)) return token;
    return labelled || nearKeyword(whole, offset, end) ? marker("secret") : token;
  });
}
