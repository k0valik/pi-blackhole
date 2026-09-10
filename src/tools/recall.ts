/**
 * Unified recall tool — handles #N transcript indices, 12-char hex om memory ids,
 * and free-text search (BM25 + regex).
 *
 * Created by pi-vcc-om. Replaces pi-vcc's vcc_recall and OM's standalone recall-observation.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages } from "../core/load-messages";
import { clip } from "../core/content";
import { searchEntriesDetailed, getFileIndicators, getTouchedFiles } from "../core/search-entries";
import type { RenderedEntry } from "../core/render-entries";
import type { SearchHit } from "../core/search-entries";
import { formatRecallEntry, formatTouchedOutput } from "../core/format-recall";
import {
  capRecallBlocks,
  expandAllocation,
  DEFAULT_RECALL_RESPONSE_MAX_CHARS,
} from "../core/recall-budget";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope, normalizeRecallMode } from "../core/recall-scope";
import { parseDrillDown, expandEntryFile } from "../core/drill-down.js";
import { recallMemorySources, type Entry } from "../om/ledger/recall.js";
import { renderRecallSourceEntries } from "../om/serialize.js";
import {
  findObservationsForEntryIds,
  findReflectionsForEntryIds,
  formatRelatedObservations,
  buildIndexMap,
  formatEntryIndexAnnotation,
  clipBody,
} from "../om/reverse-recall.js";

// ── Pi-vcc recall logic ──────────────────────────────────────────────────

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/**
 * Clip a fully-rendered expanded entry to its per-entry budget share. Adds a
 * continuation marker pointing at #N:text (message body) / #N:path (file
 * content) drill-downs, which page the stored payload in full.
 */
export const clipExpandedEntry = (e: RenderedEntry, alloc: number): RenderedEntry => {
  if (alloc <= 0 || e.summary.length <= alloc) return e;
  const body = clip(e.summary, alloc);
  return {
    ...e,
    summary: `${body}\n… [entry #${e.index} truncated — use recall #${e.index}:text:full for the full body, #${e.index}:path:full for tool file content]`,
  };
};

/**
 * Merge expanded (full-content) entries into search results.
 * Overlapping entries get their summary replaced with full content.
 * Non-overlapping expanded entries are appended. Results are sorted by index.
 */
export function mergeExpandedIntoSearchResults(
  searchResults: SearchHit[],
  expandedEntries: RenderedEntry[],
): SearchHit[] {
  if (expandedEntries.length === 0) return searchResults;

  const expandedByIndex = new Map(expandedEntries.map((e) => [e.index, e]));

  // Replace truncated summaries with full content for expanded indices
  const merged = searchResults.map((r) => {
    const full = expandedByIndex.get(r.index);
    return full ? { ...r, summary: full.summary } : r;
  });

  // Append expand-only entries not already in search results
  for (const fe of expandedEntries) {
    if (!merged.some((r) => r.index === fe.index)) {
      merged.push(fe as SearchHit);
    }
  }

  // Maintain natural order by index
  merged.sort((a, b) => a.index - b.index);
  return merged;
}

async function vccRecall(
  params: {
    query?: string;
    expand?: number[];
    page?: number;
    scope?: "lineage" | "all";
    mode?: string;
  },
  ctx: any,
  maxChars = DEFAULT_RECALL_RESPONSE_MAX_CHARS,
) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return {
      content: [{ type: "text" as const, text: "No session file available." }],
      details: undefined,
    };
  }
  const scope = normalizeRecallScope(params.scope);
  const mode = normalizeRecallMode(params.mode);
  const lineageEntryIds =
    scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;

  // ── "touched" mode: aggregate file operations ──
  if (mode === "touched") {
    const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
    const touched = getTouchedFiles(rawMessages, rendered);
    const text = formatTouchedOutput(touched, params.page, undefined, maxChars);
    return { content: [{ type: "text" as const, text }], details: undefined };
  }

  const expandSet = new Set(params.expand ?? []);
  const hasExpand = expandSet.size > 0;

  // ── Pre-load full messages if expand is requested ──
  let expandedFullEntries: RenderedEntry[] | undefined;
  if (hasExpand) {
    const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
    const requested = [...expandSet];
    const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
    const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
    if (invalid.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}`,
          },
        ],
        details: undefined,
      };
    }
    expandedFullEntries = requested
      .map((i) => byIndex.get(i))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    // Per-entry budget share: 12 huge entries each get ~budget/12 (never
    // verbatim unbounded); each carries a continuation marker to the
    // full payload via #N:text / #N:path drill-down.
    if (expandedFullEntries.length > 0 && maxChars > 0) {
      const alloc = expandAllocation(expandedFullEntries.length, maxChars);
      expandedFullEntries = expandedFullEntries.map((e) => clipExpandedEntry(e, alloc));
    }

    // Expand-only path (no query): return expanded entries immediately
    if (!params.query) {
      const entriesHeader =
        (scope === "all" ? "Scope: all\n\n" : "") +
        `Session history (${expandedFullEntries.length} entries):`;
      const entryBlocks = expandedFullEntries.map((e) => formatRecallEntry(e as SearchHit));

      // Coupling: look up related OM observations
      let obsBlock: string[] = [];
      const expandedIds = expandedFullEntries.map((e) => e.id).filter(Boolean);
      if (expandedIds.length > 0) {
        try {
          const branchEntries = ctx.sessionManager.getBranch() as Entry[];
          const obs = findObservationsForEntryIds(branchEntries, expandedIds);
          const refs = findReflectionsForEntryIds(branchEntries, expandedIds);
          if (obs.length > 0 || refs.length > 0) {
            obsBlock = [formatRelatedObservations(obs, refs)];
          }
        } catch {
          /* branch may not be available */
        }
      }

      const capped = capRecallBlocks({
        header: entriesHeader,
        entryBlocks,
        tailBlocks: obsBlock,
        budget: maxChars,
        continuation: "Use expand:[N] individually, or #N:text / #N:path to page a specific entry",
      });

      return {
        content: [{ type: "text" as const, text: capped.text }],
        details: undefined,
      };
    }
    // With query: fall through to search, then merge expanded entries into results
  }

  const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
  const searchResult = params.query?.trim()
    ? searchEntriesDetailed(msgs, rawMessages, params.query, undefined, mode)
    : undefined;
  let allResults: SearchHit[] = searchResult
    ? searchResult.hits
    : msgs.slice(-DEFAULT_RECENT).map((entry, i) => {
        const msgIndex = Math.max(0, msgs.length - DEFAULT_RECENT) + i;
        const msg = rawMessages[msgIndex];
        if (msg) {
          const indicators = getFileIndicators(msg);
          if (indicators.length > 0) {
            return { ...entry, fileMatches: indicators };
          }
        }
        return entry;
      });

  // Merge expanded entries into full result set BEFORE pagination
  // so pagination counts and positioning stay consistent
  let appendedExpandCount = 0;
  if (expandedFullEntries) {
    // Track expand-only entries that don't match the query so the header can distinguish them
    const existingIndices = new Set(allResults.map((r) => r.index));
    appendedExpandCount = expandedFullEntries.filter((fe) => !existingIndices.has(fe.index)).length;
    allResults = mergeExpandedIntoSearchResults(allResults, expandedFullEntries);
  }

  if (params.query?.trim()) {
    const page = Math.max(1, params.page ?? 1);
    const truncationNote = searchResult?.truncated
      ? ` — showing ${searchResult.hits.length} of ${searchResult.totalBeforeCap} matches, refine your query for more precise results`
      : "";
    const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
    if (allResults.length > 0 && page > totalPages) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Page ${page} is outside the available range 1-${totalPages} (${allResults.length} matches${scope === "all" ? " (scope: all)" : ""}${truncationNote}). Use a page between 1 and ${totalPages}.`,
          },
        ],
        details: undefined,
      };
    }
    const start = (page - 1) * PAGE_SIZE;
    const pageResults: SearchHit[] = allResults.slice(start, start + PAGE_SIZE);
    if (pageResults.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No matches for "${params.query}" in session history.`,
          },
        ],
        details: undefined,
      };
    }
    const scopeSuffix = scope === "all" ? " (scope: all)" : "";
    const matchCount = allResults.length - appendedExpandCount;
    const header =
      totalPages > 1
        ? `Page ${page}/${totalPages} (${matchCount} matches${appendedExpandCount > 0 ? ` + ${appendedExpandCount} expanded` : ""}${scopeSuffix}${truncationNote})`
        : `${matchCount} matches${appendedExpandCount > 0 ? ` (+ ${appendedExpandCount} expanded)` : ""}${scopeSuffix}${truncationNote}`;
    const footer =
      page < totalPages
        ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
        : "";

    let output: string;
    {
      const pageHeader = `${header} for "${params.query}":`;
      const entryBlocks = pageResults.map((e) => formatRecallEntry(e, params.query));
      const footerBlock = footer ? [footer.replace(/^\n--- /, "--- ").trim()] : [];

      // Coupling: augment search results with related observations
      let obsBlock: string[] = [];
      const pageResultIds = pageResults.map((r) => r.id).filter(Boolean);
      if (pageResultIds.length > 0) {
        try {
          const branchEntries = ctx.sessionManager.getBranch() as Entry[];
          const obs = findObservationsForEntryIds(branchEntries, pageResultIds);
          const refs = findReflectionsForEntryIds(branchEntries, pageResultIds);
          if (obs.length > 0 || refs.length > 0) {
            obsBlock = [formatRelatedObservations(obs, refs)];
          }
        } catch {
          /* branch may not be available */
        }
      }

      const capped = capRecallBlocks({
        header: pageHeader,
        entryBlocks,
        tailBlocks: footerBlock.concat(obsBlock),
        budget: maxChars,
        continuation: page < totalPages ? `Use page:${page + 1} for more results` : "",
      });
      output = capped.text;
    }

    return {
      content: [{ type: "text" as const, text: output }],
      details: undefined,
    };
  }

  // No query: show recent entries (expand already merged above)
  const recentHeader =
    (scope === "all" ? "Scope: all\n\n" : "") + `Session history (${allResults.length} entries):`;
  const recentBlocks = allResults.map((e) => formatRecallEntry(e));
  const cappedRecent = capRecallBlocks({
    header: recentHeader,
    entryBlocks: recentBlocks,
    budget: maxChars,
    continuation: "Refine the query or use expand:[N] for specific entries",
  });
  return {
    content: [{ type: "text" as const, text: cappedRecent.text }],
    details: undefined,
  };
}

// ── Observational-memory recall logic ─────────────────────────────────────

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
const VCC_ENTRY_PATTERN = /^#(\d+)$/;

async function omRecall(memoryId: string, ctx: any, maxChars = DEFAULT_RECALL_RESPONSE_MAX_CHARS) {
  if (!MEMORY_ID_PATTERN.test(memoryId)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`,
        },
      ],
      details: undefined,
    };
  }
  const branchEntries = ctx.sessionManager.getBranch() as Entry[];
  const result = recallMemorySources(branchEntries, memoryId);
  if (result.status === "not_found") {
    return {
      content: [
        {
          type: "text" as const,
          text: `No observation or reflection with id ${memoryId} was found on the current branch.`,
        },
      ],
      details: undefined,
    };
  }

  const header: string[] = [];
  if (result.collision) header.push(`ID ${result.memoryId} matched multiple items.`);

  const entryBlocks: string[] = [];
  for (const ref of result.reflections) {
    entryBlocks.push(
      `[${ref.reflection.id}] ${clipBody(ref.reflection.content, ref.reflection.id)}`,
    );
  }
  for (const obs of result.observations) {
    const dropped = obs.status === "dropped" ? " [dropped]" : "";
    entryBlocks.push(
      `[${obs.observation.id}]${dropped} ${obs.observation.timestamp} [${obs.observation.relevance}] ${clipBody(obs.observation.content, obs.observation.id)}`,
    );
  }

  let sourcesBlock = "";
  if (result.sourceEntries.length > 0) {
    const src: string[] = ["Sources:"];
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        const { rendered } = await Promise.resolve(loadAllMessages(sessionFile, false));
        const idToIndex = buildIndexMap(rendered);
        const indexAnnotation = formatEntryIndexAnnotation(
          result.observations.flatMap((o) => o.sourceEntryIds),
          idToIndex,
        );
        if (indexAnnotation) src.push(indexAnnotation);
      }
    } catch {
      /* ignore errors from index mapping */
    }
    src.push(renderRecallSourceEntries(result.sourceEntries));
    sourcesBlock = src.join("\n\n");
  }

  if (entryBlocks.length === 0 && !sourcesBlock && header.length === 0) {
    return {
      content: [
        { type: "text" as const, text: `Memory ${memoryId} found, but no evidence rendered.` },
      ],
      details: undefined,
    };
  }

  const capped = capRecallBlocks({
    header: header.join(" "),
    entryBlocks,
    tailBlocks: sourcesBlock ? [sourcesBlock] : undefined,
    budget: maxChars,
    continuation: "Full bodies stay stored — page the underlying entries via the #N source indices",
  });

  return { content: [{ type: "text" as const, text: capped.text }], details: undefined };
}

// ── Unified recall tool ──────────────────────────────────────────────────

export function registerRecallTool(
  pi: ExtensionAPI,
  omRuntime?: { config?: { recallResponseMaxChars?: number } },
): void {
  // Resolved per call (not once at registration): omRuntime.config is a live
  // reference reloaded from disk (Runtime.reloadConfig), so a settings-UI edit
  // applies without /reload. A registration-time snapshot would go stale.
  const resolveMaxChars = () =>
    omRuntime?.config?.recallResponseMaxChars ?? DEFAULT_RECALL_RESPONSE_MAX_CHARS;

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search session history and earlier lines omitted, file write/edit content by text/regex. " +
      "Expand entries (#N), drill-down file content (#N:path) or message text (#N:text) with paging, or aggregate touched files (mode:touched). " +
      "Responses are capped at a character budget; #N:text / #N:path page the full stored payload.",
    promptSnippet:
      "Search session history + file write/edit content by text/regex. #N expand, #N:path / #N:text drill-down with optional :offset:limit or :full, mode:file/touched.",
    promptGuidelines: [
      "Use recall — literal text/regex search across session history and file write/edit content. #N expands an entry; #N:path with optional :offset:limit or :full drills down into file content; #N:text pages a message body; 12-char hex ids recover observation/reflection sources. mode:file for file-content-only, mode:touched for aggregated files-by-path. scope:'all' to search the full session. If no results, try fewer terms or a regex pattern.",
      "Use recall — when a drill-down path matches multiple files, options are listed. Narrow with a more specific path substring. Only full-file writes are indexed for text search (edit diffs are not).",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Text/regex search; #N expands entry; #N:path drills file (#N:file auto-selects); #N:text pages a message body; #N:path:full all lines; #N:path:offset:limit range; 12-char hex for observations. Only full-file writes indexed.",
        }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), {
          description:
            "Entry indices to return full untruncated content for. Standalone or with query.",
        }),
      ),
      page: Type.Optional(
        Type.Number({
          description: "Page number (1-based) for paginated results. Default: 1.",
        }),
      ),
      scope: Type.Optional(
        StringEnum(["lineage", "all"] as const, {
          description: "Search scope. lineage = active lineage (default), all = entire session.",
        }),
      ),
      mode: Type.Optional(
        StringEnum(["hybrid", "file", "touched"] as const, {
          description:
            "What content to search. hybrid (default) = all session content. file = file content only. touched = files-by-path summary with entry indices.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const maxChars = resolveMaxChars();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text" as const, text: "No session file available." }],
          details: undefined,
        };
      }

      const scope = normalizeRecallScope(params.scope);
      const lineageEntryIds =
        scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;

      // Drill-down: #N:path resolves to file-scoped tool content. Anchored so
      // inline mentions like "see #42:auth.ts" are never treated as drill-down.
      // Honors scope like every other recall path: the target entry must be on
      // the active lineage unless scope:'all'. Membership is checked against
      // global indices; expandEntryFile keeps loading unfiltered so #N stays
      // aligned with the global message index.
      const q = params.query?.trim();
      if (q && parseDrillDown(q)) {
        const parsed = parseDrillDown(q)!;
        if (lineageEntryIds) {
          const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === parsed.index)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.`,
                },
              ],
              details: undefined,
            };
          }
        }
        const text = expandEntryFile(
          sessionFile,
          parsed.index,
          parsed.pathPattern,
          parsed.full,
          parsed.offset,
          parsed.limit,
        );
        return {
          content: [{ type: "text" as const, text }],
          details: undefined,
        };
      }
      if (q && VCC_ENTRY_PATTERN.test(q)) {
        // #N → expand entry indices
        const match = q.match(VCC_ENTRY_PATTERN);
        const index = match ? parseInt(match[1], 10) : NaN;
        if (!Number.isNaN(index)) {
          return vccRecall({ query: "", expand: [index] }, ctx, maxChars);
        }
      }
      if (q && MEMORY_ID_PATTERN.test(q)) {
        return omRecall(q, ctx, maxChars);
      }
      // Default: pi-vcc search
      return vccRecall(params, ctx, maxChars);
    },
  });
}
