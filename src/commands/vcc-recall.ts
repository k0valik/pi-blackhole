/**
 * /blackhole-recall command — search session history.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/vcc-recall.ts)
 * Ported and renamed to /blackhole-recall for blackhole.
 *
 * NOTE: intentionally NOT covered by the recall tool response budget (issue
 * #83, `recallResponseMaxChars`). The command renders to the TUI for the
 * human operator, not into model context, so per-entry snippet/body clips
 * (shared via search-entries / reverse-recall) apply but no total cap is
 * enforced. Capping user-facing command output is a separate follow-up.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAllMessages } from "../core/load-messages.js";
import { searchEntriesDetailed, getTouchedFiles } from "../core/search-entries.js";
import { formatRecallOutput, formatTouchedOutput } from "../core/format-recall.js";
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
  } catch {
    /* branch may not be available */
  }
  return output;
}

export const registerVccRecallCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("blackhole-recall", {
    description:
      "Search session history. Defaults to active lineage. Usage: /blackhole-recall <query> [page:N] [scope:all] [mode:file|touched]",
    handler: async (args: string, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file available.", "error");
        return;
      }

      const raw = args.trim();
      const parsed = parseRecallScope(raw);
      const lineageEntryIds =
        parsed.scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;
      const mode = parsed.mode;

      if (mode === "touched") {
        const pageMatch = raw.match(/\bpage:(\d+)\b/i);
        const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
        const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const touched = getTouchedFiles(rawMessages, rendered);
        const text = formatTouchedOutput(touched, page);
        pi.sendMessage(
          { customType: "blackhole-recall", content: text, display: true },
          { triggerTurn: true },
        );
        return;
      }

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
      const {
        hits: allResults,
        totalBeforeCap,
        truncated,
      } = searchEntriesDetailed(rendered, rawMessages, query, undefined, mode);

      const start = (page - 1) * PAGE_SIZE;
      const pageResults = allResults.slice(start, start + PAGE_SIZE);
      const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
      const scopeSuffix = parsed.scope === "all" ? " (scope: all)" : "";
      // Say both the visible and real total: the hard cap can discard genuine
      // matches, so the capped count alone would understate the real total.
      // Neutral wording ("showing", not "showing top"): regex-path hits are
      // boolean/chronological with no relevance score, so "top" would falsely
      // imply a ranking that only the BM25 path has.
      const capNote = truncated
        ? ` — showing ${allResults.length} of ${totalBeforeCap} matches, refine your query for more precise results`
        : "";
      // A page beyond the reachable range isn't "no matches" — matches exist,
      // the page just isn't reachable. Say so explicitly instead of falling
      // through to formatRecallOutput's zero-hit message, which would be false.
      if (allResults.length > 0 && page > totalPages) {
        const scopeArg = parsed.scope === "all" ? " scope:all" : "";
        const guidance = truncated
          ? `Use /blackhole-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}.`
          : `Use /blackhole-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}, or refine your query.`;
        pi.sendMessage(
          {
            customType: "blackhole-recall",
            content:
              `Page ${page} is outside the available range 1-${totalPages} ` +
              `(${allResults.length} matches${scopeSuffix}${capNote}). ${guidance}`,
            display: true,
          },
          { triggerTurn: true },
        );
        return;
      }
      const header =
        totalPages > 1
          ? `Page ${page}/${totalPages} (${totalBeforeCap} total matches${capNote}${scopeSuffix})`
          : `${totalBeforeCap} matches${capNote}${scopeSuffix}`;
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
