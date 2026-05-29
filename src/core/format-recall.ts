import type { SearchHit, FileMatch } from "./search-entries";

/** Render one file indicator line. */
function formatFileMatch(fm: FileMatch, index: number, isQuery: boolean): string {
  const label = isQuery
    ? (fm.lineCount === 1 ? "match" : "matches")
    : (fm.lineCount === 1 ? "line" : "lines");
  let line = `  [${fm.toolName}] ${fm.path} — ${fm.lineCount} ${label}    use #${index}:${fm.path}`;
  if (fm.snippet) {
    line += `\n    | ${fm.snippet}`;
  }
  return line;
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
