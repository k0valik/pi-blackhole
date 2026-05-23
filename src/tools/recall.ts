/**
 * Unified recall tool — handles #N transcript indices, 12-char hex om memory ids,
 * and free-text search (BM25 + regex).
 *
 * Created by pi-vcc-om. Replaces pi-vcc's vcc_recall and OM's standalone recall-observation.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages } from "../core/load-messages";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope } from "../core/recall-scope";
import {
	recallMemorySources,
	type Entry,
} from "../om/ledger/recall.js";
import { renderRecallSourceEntries } from "../om/serialize.js";

// ── Pi-vcc recall logic ──────────────────────────────────────────────────

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
	requested.filter((i) => !Number.isInteger(i) || !available.has(i));

async function vccRecall(params: { query?: string; expand?: number[]; page?: number; scope?: "lineage" | "all" }, ctx: any) {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return { content: [{ type: "text" as const, text: "No session file available." }], details: undefined };
	}
	const scope = normalizeRecallScope(params.scope);
	const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;
	const expandSet = new Set(params.expand ?? []);
	const hasExpand = expandSet.size > 0;

	if (hasExpand && !params.query) {
		const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
		const requested = [...expandSet];
		const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
		const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
		if (invalid.length > 0) {
			return { content: [{ type: "text" as const, text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }], details: undefined };
		}
		const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
		const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
		return { content: [{ type: "text" as const, text: output }], details: undefined };
	}

	const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
	const allResults = params.query?.trim()
		? searchEntries(msgs, rawMessages, params.query)
		: msgs.slice(-DEFAULT_RECENT);

	if (params.query?.trim()) {
		const page = Math.max(1, params.page ?? 1);
		const start = (page - 1) * PAGE_SIZE;
		const pageResults = allResults.slice(start, start + PAGE_SIZE);
		const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
		const scopeSuffix = scope === "all" ? " (scope: all)" : "";
		const header = totalPages > 1
			? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
			: `${allResults.length} matches${scopeSuffix}`;
		const footer = page < totalPages
			? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
			: "";
		const output = formatRecallOutput(pageResults, params.query, header) + footer;
		return { content: [{ type: "text" as const, text: output }], details: undefined };
	}

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
			"- A text/regex query to search conversation content. Multi-word queries use BM25 ranking with stopword filtering.\n" +
			"Search tips: use unique concrete words (file names, function names, exact phrases), not conceptual questions. Regex metacharacters (|, *, .) trigger regex mode. Default scope is active lineage; use scope:'all' for off-lineage branches.",
		promptSnippet:
			"recall: Text/regex search (not semantic). Also: 12-char hex ids recover obs/reflection sources; #N indices expand transcript entries. Use concrete words for search. scope:'all' for off-lineage.",
		promptGuidelines: [
			"Use recall with a 12-char hex id before making an important decision that depends on a compacted observation or reflection whose details are unclear.",
			"Use recall with a search query when you need to find specific conversation content. Use unique concrete terms (file paths, function names, error messages, exact phrases), not conceptual questions. Example: 'merge_design.md' not 'what did we decide about merging'.",
			"Use recall with #N to expand a transcript entry reference from compacted output.",
			"After compaction, the summary includes observation/reflection ids in brackets. Use recall with those ids to recover full source evidence.",
			"If you get no results, try fewer terms, use a distinctive single word, or use a regex pattern (e.g. 'fork.*pi-vcc').",
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const q = params.query?.trim();
			// Dispatch by format
			if (q && VCC_ENTRY_PATTERN.test(q)) {
				return vccRecall({ ...params, query: q }, ctx);
			}
			if (q && MEMORY_ID_PATTERN.test(q)) {
				return omRecall(q, ctx);
			}
			// Default: pi-vcc search
			return vccRecall(params, ctx);
		},
	});
}
