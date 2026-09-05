/**
 * /blackhole-export command — distill the project's observational memory
 * (observations, reflections across past session files + pending buffers)
 * into an import-ready markdown artifact. plan-07 Appendix A.
 */
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function defaultOutPath(cwd: string, now: Date): string {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 13).replace(/[-T]/g, "") + iso.slice(14, 16);
  return join(cwd, `memory-export-${stamp}.md`);
}

export const registerBlackholeExportCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("blackhole-export", {
    description:
      "Export distilled project memory (observations/reflections from past sessions) to markdown. Usage: /blackhole-export [out:<path>]. If no out: is provided, writes to the project local cwd.",
    handler: async (args: string, ctx) => {
      ctx.ui.notify(
        "Exporting project memory… this may take a few minutes depending on the number of session files for the project.",
        "info",
      );
      // Yield so the TUI can paint the warning before the heavy scan blocks.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const outMatch = args.match(/\bout:(\S+)/);
      const now = new Date();
      const outPath = outMatch
        ? isAbsolute(outMatch[1])
          ? outMatch[1]
          : join(ctx.cwd, outMatch[1])
        : defaultOutPath(ctx.cwd, now);

      if (outMatch && !outPath.toLowerCase().endsWith(".md")) {
        ctx.ui.notify(
          `Export path must be a markdown file: ${outPath}. Use out:<path-to-file>.md`,
          "error",
        );
        return;
      }

      const resolvedOut = resolve(outPath);
      const userOut = outMatch?.[1];
      if (userOut && !isAbsolute(userOut)) {
        const rel = relative(resolve(ctx.cwd), resolvedOut);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          ctx.ui.notify(`Export path escapes current directory: ${outPath}`, "error");
          return;
        }
      }

      const { findGitRoot } = await import("../project-recall/session-dir.js");
      const { root: gitRoot, warning: gitWarning } = await findGitRoot(ctx.cwd);
      if (gitWarning) {
        ctx.ui.notify(gitWarning, "warning");
      }
      const activeSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

      // Throttled progress: Scanning N files… keeps the TUI alive during the
      // ~35s (98 files) to ~2min (644 files) corpus walk.
      let lastProgressAt = 0;
      const onProgress = ({
        scanned,
        total,
      }: {
        scanned: number;
        total: number;
        phase: string;
      }) => {
        const t = Date.now();
        if (t - lastProgressAt < 800 && scanned !== 0 && scanned !== total) return;
        lastProgressAt = t;
        if (scanned === 0 && total > 0) {
          ctx.ui.notify(
            `Scanning ${total} session files for observational memory markers…`,
            "info",
          );
        } else if (total > 0) {
          ctx.ui.notify(`Scanning ${scanned}/${total} session files…`, "info");
        }
      };

      const { buildProjectMemoryCorpusAsync } = await import("../project-recall/corpus.js");
      const corpus = await buildProjectMemoryCorpusAsync(
        {
          cwd: ctx.cwd,
          gitRoot,
          activeSessionFile,
          agentDir: getAgentDir(),
        },
        onProgress,
      );

      if (
        corpus.observations.length === 0 &&
        corpus.reflections.length === 0 &&
        corpus.droppedIds.size === 0
      ) {
        ctx.ui.notify(
          `No observational memory found for ${basename(corpus.projectRoot)} (${corpus.sessionsConsidered} sessions scanned).`,
          "warning",
        );
        return;
      }

      if (corpus.observations.length > 0 || corpus.reflections.length > 0) {
        ctx.ui.notify(
          `Ranking ${corpus.observations.length} observations and ${corpus.reflections.length} reflections…`,
          "info",
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const { buildExportMarkdownAsync } = await import("../project-recall/format-export.js");
      const { markdown, stats } = await buildExportMarkdownAsync(corpus, {
        now: now.getTime(),
        title: basename(corpus.projectRoot),
      });

      try {
        writeFileSync(outPath, markdown, "utf-8");
      } catch (error) {
        ctx.ui.notify(`Export failed to write ${outPath}: ${String(error)}`, "error");
        return;
      }

      const lines = [
        `Project memory exported to ${outPath}`,
        "",
        `- sessions scanned: ${stats.sessionsConsidered} (${stats.filesWithMarkers} with memory entries)`,
        `- observations: ${stats.observationsTotal} → ${stats.observationsRendered} rendered (${stats.duplicatesCollapsed} duplicates collapsed, ${stats.observationsFiltered} below viability gate)`,
        stats.topicGroups > 0
          ? `- ${stats.topicGroups} topic groups identified; each observation shows its **topic badge**`
          : null,
        `- reflections: ${stats.reflectionsTotal}`,
      ];
      if (stats.orphanedObservations > 0 || stats.orphanedReflections > 0) {
        lines.push(
          `- unattributed pending memory: ${stats.orphanedObservations} obs / ${stats.orphanedReflections} reflections from ${stats.orphanedSessions} lost session(s)`,
        );
      }
      if (stats.droppedExcluded > 0) {
        lines.push(`- dropper-pruned ids excluded: ${stats.droppedExcluded}`);
      }
      lines.push("", "The file is plain markdown — curate it, then import into any memory system.");

      pi.sendMessage({
        customType: "blackhole-export",
        content: lines.join("\n"),
        display: true,
      });
    },
  });
};
