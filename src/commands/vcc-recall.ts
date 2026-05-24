/**
 * /blackhole-recall command — search session history.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/vcc-recall.ts)
 * Ported and renamed to /blackhole-recall for blackhole.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages } from "../core/load-messages.js";
import { searchEntries } from "../core/search-entries.js";
import { formatRecallOutput } from "../core/format-recall.js";
import { getActiveLineageEntryIds } from "../core/lineage.js";
import { parseRecallScope } from "../core/recall-scope.js";
import {
	findObservationsForEntryIds,
	findReflectionsForEntryIds,
	formatRelatedObservations,
} from "../om/reverse-recall.js";
import type { Entry } from "../om/ledger/recall.js";

const PAGE_SIZE = 5;
const DEFAULT_RECENT = 25;

async function augmentWithObservations(
	output: string,
	rendered: { id: string }[],
	ctx: any,
): Promise<string> {
	const ids = rendered.map((e) => e.id).filter(Boolean);
	if (ids.length === 0) return output;
	try {
		const branchEntries = ctx.sessionManager.getBranch() as Entry[];
		const obs = findObservationsForEntryIds(branchEntries, ids);
		const refs = findReflectionsForEntryIds(branchEntries, ids);
		if (obs.length > 0 || refs.length > 0) {
			return output + "\n\n" + formatRelatedObservations(obs, refs);
		}
	} catch { /* branch may not be available */ }
	return output;
}

export const registerVccRecallCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("blackhole-recall", {
		description:
			"Search session history. Defaults to active lineage; add scope:all for off-lineage branches. Usage: /blackhole-recall <query> [page:N] [scope:all]",
		handler: async (args: string, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file available.", "error");
				return;
			}

			const raw = args.trim();
			const parsed = parseRecallScope(raw);
			const lineageEntryIds =
				parsed.scope === "lineage"
					? getActiveLineageEntryIds(ctx.sessionManager)
					: undefined;

			if (!parsed.text) {
				// No query: show recent entries
				const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
				const recent = rendered.slice(-DEFAULT_RECENT);
				const base = (parsed.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
				const output = await augmentWithObservations(base, recent, ctx);
				pi.sendMessage(
					{ customType: "blackhole-recall", content: output, display: true },
					{ triggerTurn: true },
				);
				return;
			}

			// Parse page:N from args
			const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
			const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
			const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();

			if (!query) {
				const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
				const recent = rendered.slice(-DEFAULT_RECENT);
				const base = (parsed.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
				const output = await augmentWithObservations(base, recent, ctx);
				pi.sendMessage(
					{ customType: "blackhole-recall", content: output, display: true },
					{ triggerTurn: true },
				);
				return;
			}

			const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
			const allResults = searchEntries(rendered, rawMessages, query);

			const start = (page - 1) * PAGE_SIZE;
			const pageResults = allResults.slice(start, start + PAGE_SIZE);
			const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
			const scopeSuffix = parsed.scope === "all" ? " (scope: all)" : "";
			const header =
				totalPages > 1
					? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
					: `${allResults.length} matches${scopeSuffix}`;
			const footer =
				page < totalPages
					? `\n--- /blackhole-recall ${query}${parsed.scope === "all" ? " scope:all" : ""} page:${page + 1} ---`
					: "";
			const base = formatRecallOutput(pageResults, query, header) + footer;
			const output = await augmentWithObservations(base, pageResults, ctx);
			pi.sendMessage(
				{ customType: "blackhole-recall", content: output, display: true },
				{ triggerTurn: true },
			);
		},
	});
};
