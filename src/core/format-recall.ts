import type { SearchHit, FileMatch, TouchedFile } from "./search-entries";

// ── Path shortening ───────────────────────────────────────────────────────

const CWD = process.cwd();

/**
 * Shorten an absolute file path for display:
 * - If within cwd, return `./relative/path`
 * - Otherwise, show last 3 path components with `.../` prefix
 * - Short paths (≤3 components) returned as-is
 */
export function shortPath(fullPath: string): string {
  // Normalize backslashes to forward slashes for cross-platform path handling
  const normalized = fullPath.replace(/\\/g, "/");
  const cwdNormalized = CWD.replace(/\\/g, "/");
  if (normalized.startsWith(cwdNormalized + "/")) {
    return "." + normalized.slice(cwdNormalized.length);
  }
  const parts = normalized.split("/");
  if (parts.length > 3) {
    return ".../" + parts.slice(-3).join("/");
  }
  return normalized;
}

// ── File indicator formatting ─────────────────────────────────────────────

/** Render one file indicator line with shortened path. */
function formatFileMatch(fm: FileMatch, index: number, isQuery: boolean): string {
  const label = isQuery
    ? (fm.lineCount === 1 ? "match" : "matches")
    : (fm.lineCount === 1 ? "line" : "lines");
  const displayPath = shortPath(fm.path);
  let line = `  [${fm.toolName}] ${displayPath} — ${fm.lineCount} ${label}    use #${index}:${fm.path}`;
  if (fm.snippet) {
    line += `\n    | ${fm.snippet}`;
  }
  return line;
}

// ── Touched file output ───────────────────────────────────────────────────

const TOUCHED_PAGE_SIZE = 5;

/**
 * Format aggregated "files touched" output.
 */
export function formatTouchedOutput(
  touched: TouchedFile[],
  page?: number,
  pageSize?: number,
): string {
  if (touched.length === 0) {
    return "No file operations found in session history.";
  }

  const ps = pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.ceil(touched.length / ps);
  const currentPage = Math.max(1, page ?? 1);
  const start = (currentPage - 1) * ps;
  const pageFiles = touched.slice(start, start + ps);

  const header = totalPages > 1
    ? `Page ${currentPage}/${totalPages} (${touched.length} total files)`
    : `${touched.length} files touched`;

  const lines = pageFiles.map((tf) => {
    const displayPath = shortPath(tf.path);
    const indices = tf.entries
      .map((e) => `#${e.index} (${e.toolName})`)
      .join(", ");
    return `  ${displayPath}    ${indices}`;
  });

  let result = `${header}:\n\n${lines.join("\n")}`;

  if (currentPage < totalPages) {
    result += `\n\n--- Use page:${currentPage + 1} for more results ---`;
  }

  return result;
}

export const formatRecallOutput = (
  entries: SearchHit[],
  query?: string,
  headerOverride?: string,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  const header = headerOverride
    ? `${headerOverride} for "${query}":`
    : query
      ? `Found ${entries.length} matches for "${query}":`
      : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const body = query && e.snippet ? e.snippet : e.summary;
    let line = `#${e.index} [${e.role}]`;

    // Entry text on next line if it's long or has fileMatches
    if (e.fileMatches?.length) {
      line += `\n  ${body}`;
      // Only show top 3 file matches
      const isQuery = Boolean(query);
      const topFileMatches = e.fileMatches.slice(0, 3);
      for (const fm of topFileMatches) {
        line += `\n${formatFileMatch(fm, e.index, isQuery)}`;
      }
      if (e.fileMatches.length > 3) {
        line += `\n  ...(${e.fileMatches.length - 3} more file matches)`;
      }
    } else {
      line += ` ${body}`;
    }

    return line;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
