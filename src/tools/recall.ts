/**
 * Unified recall tool — handles #N transcript indices, 12-char hex om memory ids,
 * and free-text search (BM25 + regex).
 *
 * Created by pi-vcc-om. Replaces pi-vcc's vcc_recall and OM's standalone recall-observation.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages } from "../core/load-messages";
import { searchEntries, getFileIndicators } from "../core/search-entries";
import type { RenderedEntry } from "../core/render-entries";
import type { SearchHit } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope, normalizeRecallMode } from "../core/recall-scope";
import { parseDrillDown, expandEntryFile } from "../core/drill-down.js";
import {
	recallMemorySources,
	type Entry,
} from "../om/ledger/recall.js";
import { renderRecallSourceEntries } from "../om/serialize.js";
import {
	findObservationsForEntryIds,
	findReflectionsForEntryIds,
	formatRelatedObservations,
	buildIndexMap,
	formatEntryIndexAnnotation,
} from "../om/reverse-recall.js";

// ── Pi-vcc recall logic ──────────────────────────────────────────────────

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
	requested.filter((i) => !Number.isInteger(i) || !available.has(i));

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

async function vccRecall(params: { query?: string; expand?: number[]; page?: number; scope?: "lineage" | "all"; mode?: string }, ctx: any) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return { content: [{ type: "text" as const, text: "No session file available." }], details: undefined };
	}
	const scope = normalizeRecallScope(params.scope);
	const mode = normalizeRecallMode(params.mode);
	const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;
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
			return { content: [{ type: "text" as const, text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }], details: undefined };
		}
		expandedFullEntries = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));

		// Expand-only path (no query): return expanded entries immediately
		if (!params.query) {
			let output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expandedFullEntries);

			// Coupling: look up related OM observations
			const expandedIds = expandedFullEntries.map((e) => e.id).filter(Boolean);
			if (expandedIds.length > 0) {
				try {
					const branchEntries = ctx.sessionManager.getBranch() as Entry[];
					const obs = findObservationsForEntryIds(branchEntries, expandedIds);
					const refs = findReflectionsForEntryIds(branchEntries, expandedIds);
					if (obs.length > 0 || refs.length > 0) {
						output += "\n\n" + formatRelatedObservations(obs, refs);
					}
				} catch { /* branch may not be available */ }
			}

			return { content: [{ type: "text" as const, text: output }], details: undefined };
		}
		// With query: fall through to search, then merge expanded entries into results
	}

	const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
	let allResults: SearchHit[] = params.query?.trim()
		? searchEntries(msgs, rawMessages, params.query, undefined, mode)
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
	if (expandedFullEntries) {
		allResults = mergeExpandedIntoSearchResults(allResults, expandedFullEntries);
	}

	if (params.query?.trim()) {
		const page = Math.max(1, params.page ?? 1);
		const start = (page - 1) * PAGE_SIZE;
		const pageResults: SearchHit[] = allResults.slice(start, start + PAGE_SIZE);
		const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
		const scopeSuffix = scope === "all" ? " (scope: all)" : "";
		const header = totalPages > 1
			? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
			: `${allResults.length} matches${scopeSuffix}`;
		const footer = page < totalPages
			? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
			: "";

		let output = formatRecallOutput(pageResults, params.query, header) + footer;

		// Coupling: augment search results with related observations
		const pageResultIds = pageResults.map((r) => r.id).filter(Boolean);
		if (pageResultIds.length > 0) {
			try {
				const branchEntries = ctx.sessionManager.getBranch() as Entry[];
				const obs = findObservationsForEntryIds(branchEntries, pageResultIds);
				const refs = findReflectionsForEntryIds(branchEntries, pageResultIds);
				if (obs.length > 0 || refs.length > 0) {
					output += "\n\n" + formatRelatedObservations(obs, refs);
				}
			} catch { /* branch may not be available */ }
		}

		return { content: [{ type: "text" as const, text: output }], details: undefined };
	}

	// No query: show recent entries (expand already merged above)
	const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, params.query);
	return { content: [{ type: "text" as const, text: output }], details: undefined };
}

// ── Observational-memory recall logic ─────────────────────────────────────

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
const VCC_ENTRY_PATTERN = /^#(\d+)$/;

async function omRecall(memoryId: string, ctx: any) {
	if (!MEMORY_ID_PATTERN.test(memoryId)) {
		return { content: [{ type: "text" as const, text: `Memory id must be 12 lowercase hex characters. Received: ${memoryId}` }], details: undefined };
	}
	const branchEntries = ctx.sessionManager.getBranch() as Entry[];
	const result = recallMemorySources(branchEntries, memoryId);
	if (result.status === "not_found") {
		return { content: [{ type: "text" as const, text: `No observation or reflection with id ${memoryId} was found on the current branch.` }], details: undefined };
	}
	const lines: string[] = [];
	if (result.collision) lines.push(`ID ${result.memoryId} matched multiple items.`);
	for (const ref of result.reflections) {
		lines.push(`[${ref.reflection.id}] ${ref.reflection.content}`);
	}
	for (const obs of result.observations) {
		const dropped = obs.status === "dropped" ? " [dropped]" : "";
		lines.push(`[${obs.observation.id}]${dropped} ${obs.observation.timestamp} [${obs.observation.relevance}] ${obs.observation.content}`);
	}
	if (result.sourceEntries.length > 0) {
		lines.push("");
		lines.push("Sources:");
		// Cross-format nav: annotate source entries with #N indices
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				const { rendered } = await Promise.resolve(loadAllMessages(sessionFile, false));
				const idToIndex = buildIndexMap(rendered);
				const indexAnnotation = formatEntryIndexAnnotation(
					result.observations.flatMap((o) => o.sourceEntryIds),
					idToIndex,
				);
				if (indexAnnotation) lines.push(indexAnnotation);
			}
		} catch { /* ignore errors from index mapping */ }
		lines.push(renderRecallSourceEntries(result.sourceEntries));
	}
	const text = lines.join("\n") || `Memory ${memoryId} found, but no evidence rendered.`;
	return { content: [{ type: "text" as const, text }], details: undefined };
}

// ── Unified recall tool ──────────────────────────────────────────────────

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Recall session history or memory evidence. This is text/pattern matching, NOT semantic search. Accepts:\n" +
			"- A 12-char hex id [a1b2c3d4e5f6] to recover observation/reflection source evidence.\n" +
			"- A #N entry index to expand a specific transcript entry from compacted output.\n" +
			"- A #N:path pattern to drill into file content from a tool call (e.g., #42:auth.ts).\n" +
			"- A text/regex query to search conversation content. Multi-word queries use BM25 ranking with stopword filtering.\n" +
			"Search tips: use unique concrete words (file names, function names, error messages), not conceptual questions. Regex metacharacters (|, *, .) trigger regex mode. Default scope is active lineage; use scope:'all' for off-lineage branches.",
		promptSnippet:
			"recall: Search previous conversation history + file write/edit content (text/regex, mode:'file'/'transcript'). Hex observation/reflection ids and #N entry indices link both ways. #N expand, #N:path drill-down.",
		promptGuidelines: [
			"Before relying on a compacted observation or reflection, use recall with its 12-char hex id to recover full source evidence with #N entry annotations. Search results also surface related hex ids — entries and observations link both ways.",
			"When searching, use unique concrete terms (file paths, function names, quoted phrases) — file content from content-bearing tool calls (write, edit, etc.) is also indexed.",
			"If no results, try fewer/distinctive terms or a regex pattern (e.g. 'fork.*pi-vcc'). Use mode:'file' for file-only grep, mode:'transcript' for conversation-only.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "12-char hex id, #N entry index, or text/regex search terms. NOT semantic — use concrete words (file names, quoted phrases, identifiers). Regex metacharacters trigger regex mode. Multi-word = BM25-ranked OR." }),
			),
			expand: Type.Optional(
				Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for (blackhole format only)." }),
			),
			page: Type.Optional(
				Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1." }),
			),
			scope: Type.Optional(
				Type.Union([
					Type.Literal("lineage"),
					Type.Literal("all"),
				], { description: "Search scope. Default: lineage; all includes off-lineage branches." }),
			),
			mode: Type.Optional(
				Type.Union([
					Type.Literal("hybrid"),
					Type.Literal("file"),
					Type.Literal("transcript"),
				], { description: "What content to search. 'hybrid' (default) = transcript + file indicators. 'file' = file content only (grep mode). 'transcript' = conversation text only." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const q = params.query?.trim();
			// Dispatch by format
			if (q && parseDrillDown(q)) {
				const parsed = parseDrillDown(q)!;
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					return { content: [{ type: "text" as const, text: "No session file available." }], details: undefined };
				}
				const text = expandEntryFile(sessionFile, parsed.index, parsed.pathPattern, parsed.full);
				return { content: [{ type: "text" as const, text }], details: undefined };
			}
			if (q && VCC_ENTRY_PATTERN.test(q)) {
				// #N → expand entry indices
				const match = q.match(VCC_ENTRY_PATTERN);
				const index = match ? parseInt(match[1], 10) : NaN;
				if (!Number.isNaN(index)) {
					return vccRecall({ query: "", expand: [index] }, ctx);
				}
			}
			if (q && MEMORY_ID_PATTERN.test(q)) {
				return omRecall(q, ctx);
			}
			// Default: pi-vcc search
			return vccRecall(params, ctx);
		},
	});
}
