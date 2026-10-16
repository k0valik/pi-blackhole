/**
 * /blackhole-export command — distill the project's observational memory
 * (observations, reflections across past session files + pending buffers)
 * into an import-ready markdown artifact. plan-07 Appendix A.
 *
 * The handler core lives in `runBlackholeExport`, shared by the slash command
 * and the headless `--blackhole-export` flag (plan-extract-timeline §14): one
 * grammar, two entry points. The flag path is registered by
 * `registerBlackholeExportFlag`.
 */
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseBlackholeExportArgs } from "../project-recall/export-options.js";

function defaultOutPath(cwd: string, now: Date): string {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 13).replace(/[-T]/g, "") + iso.slice(14, 16);
  return join(cwd, `memory-export-${stamp}.md`);
}

/** Dependencies the shared export core needs from its caller. */
export interface BlackholeExportDeps {
  cwd: string;
  /** Session-file exclusion lookup; absent (headless `--no-session`) means no exclusion. */
  getSessionFile?: () => string | undefined | null;
  agentDir: string;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  sendMessage: (message: { customType: string; content: string; display: boolean }) => void;
  /** File writer; defaults to `writeFileSync(path, content, "utf-8")`. */
  writeFile?: (outPath: string, content: string) => void;
}

export interface BlackholeExportResult {
  ok: boolean;
  /**
   * Human-readable summary: the success receipt (same text as the transcript
   * message) or the failure reason. Headless callers print this to stdout —
   * `ctx.ui.notify` has no TUI attached there — so cron logs capture it.
   */
  summary: string;
  outPath?: string;
}

/**
 * Shared export core: parse args, build the windowed corpus, render through
 * the selected renderer, write the file. All slash-command behavior lives
 * here; the slash handler and the headless flag only supply `deps`.
 */
export async function runBlackholeExport(
  argsString: string,
  deps: BlackholeExportDeps,
): Promise<BlackholeExportResult> {
  const parsed = parseBlackholeExportArgs(argsString);
  if (!parsed.ok) {
    deps.notify(parsed.error, "error");
    return { ok: false, summary: parsed.error };
  }
  const userOut = parsed.value.out;
  const days = parsed.value.days;
  const mode = parsed.value.mode;

  deps.notify(
    "Exporting project memory… this may take a few minutes depending on the number of session files for the project.",
    "info",
  );
  // Yield so the TUI can paint the warning before the heavy scan blocks.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const now = new Date();
  const sinceMs = days !== undefined ? now.getTime() - days * 86400000 : undefined;
  const untilMs = days !== undefined ? now.getTime() : undefined;
  const outPath = userOut
    ? isAbsolute(userOut)
      ? userOut
      : join(deps.cwd, userOut)
    : defaultOutPath(deps.cwd, now);

  if (userOut && !outPath.toLowerCase().endsWith(".md")) {
    const message = `Export path must be a markdown file: ${outPath}. Use out:<path-to-file>.md`;
    deps.notify(message, "error");
    return { ok: false, summary: message };
  }

  const resolvedOut = resolve(outPath);
  if (userOut && !isAbsolute(userOut)) {
    const rel = relative(resolve(deps.cwd), resolvedOut);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      const message = `Export path escapes current directory: ${outPath}`;
      deps.notify(message, "error");
      return { ok: false, summary: message };
    }
  }

  const { findGitRoot } = await import("../project-recall/session-dir.js");
  const { root: gitRoot, warning: gitWarning } = await findGitRoot(deps.cwd);
  if (gitWarning) {
    deps.notify(gitWarning, "warning");
  }
  // Optional-tolerant: headless runs (e.g. `--no-session`) may have no
  // session file at all.
  const activeSessionFile = deps.getSessionFile?.() ?? undefined;

  // Throttled progress: Scanning N files… keeps the TUI alive during the
  // ~35s (98 files) to ~2min (644 files) corpus walk.
  let lastProgressAt = 0;
  const onProgress = ({ scanned, total }: { scanned: number; total: number; phase: string }) => {
    const t = Date.now();
    if (t - lastProgressAt < 800 && scanned !== 0 && scanned !== total) return;
    lastProgressAt = t;
    if (scanned === 0 && total > 0) {
      deps.notify(`Scanning ${total} session files for observational memory markers…`, "info");
    } else if (total > 0) {
      deps.notify(`Scanning ${scanned}/${total} session files…`, "info");
    }
  };

  const { buildProjectMemoryCorpusAsync } = await import("../project-recall/corpus.js");
  const corpus = await buildProjectMemoryCorpusAsync(
    {
      cwd: deps.cwd,
      gitRoot,
      activeSessionFile,
      agentDir: deps.agentDir,
      sinceMs,
      untilMs,
    },
    onProgress,
  );

  if (
    corpus.observations.length === 0 &&
    corpus.reflections.length === 0 &&
    corpus.droppedIds.size === 0
  ) {
    // A windowed empty result is normal (nothing recent), not alarming — and
    // not a scheduler failure either, so this stays `ok: true`.
    const message =
      days !== undefined
        ? `No observational memory found for ${basename(corpus.projectRoot)} in the last ${days} days (${corpus.sessionsConsidered} sessions scanned).`
        : `No observational memory found for ${basename(corpus.projectRoot)} (${corpus.sessionsConsidered} sessions scanned).`;
    deps.notify(message, "warning");
    return { ok: true, summary: message };
  }

  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));
  const title = basename(corpus.projectRoot);
  if (mode === "timeline") {
    const { buildTimelineExportMarkdownAsync } =
      await import("../project-recall/format-timeline-export.js");
    const { markdown: timelineMarkdown, stats: timelineStats } =
      await buildTimelineExportMarkdownAsync(corpus, {
        now: now.getTime(),
        title,
        sinceMs,
        untilMs,
      });

    try {
      writeFile(outPath, timelineMarkdown);
    } catch (error) {
      const message = `Export failed to write ${outPath}: ${String(error)}`;
      deps.notify(message, "error");
      return { ok: false, summary: message };
    }

    const timelineLines = [
      `Project memory exported to ${outPath}`,
      "",
      `- Window: ${timelineStats.windowLabel}`,
      `- Sessions: ${timelineStats.sessionsDiscovered} → ${timelineStats.sessionsScanned} (${timelineStats.filesWithMarkers} with memory)`,
      `- Observations: ${timelineStats.observationsExported} exported`,
      `- Reflections: ${timelineStats.reflectionsExported} exported`,
    ];
    if (timelineStats.entriesOutsideWindow > 0) {
      timelineLines.push(
        `- outside window: ${timelineStats.entriesOutsideWindow} entries excluded`,
      );
    }
    if (timelineStats.entriesWithoutTimestamp > 0) {
      timelineLines.push(
        `- without timestamp: ${timelineStats.entriesWithoutTimestamp} entries retained`,
      );
    }
    if (timelineStats.orphanedObservations > 0 || timelineStats.orphanedReflections > 0) {
      timelineLines.push(
        `- unattributed pending memory: ${timelineStats.orphanedObservations} obs / ${timelineStats.orphanedReflections} reflections from ${timelineStats.orphanedSessions} lost session(s)`,
      );
    }
    if (timelineStats.droppedExcluded > 0) {
      timelineLines.push(`- dropper-pruned ids excluded: ${timelineStats.droppedExcluded}`);
    }
    timelineLines.push(
      "",
      "The file is plain markdown — curate it, then import into any memory system.",
    );

    const summary = timelineLines.join("\n");
    deps.sendMessage({
      customType: "blackhole-export",
      content: summary,
      display: true,
    });
    return { ok: true, summary, outPath };
  }

  if (corpus.observations.length > 0 || corpus.reflections.length > 0) {
    deps.notify(
      `Ranking ${corpus.observations.length} observations and ${corpus.reflections.length} reflections…`,
      "info",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const { buildExportMarkdownAsync } = await import("../project-recall/format-export.js");
  const { markdown, stats } = await buildExportMarkdownAsync(corpus, {
    now: now.getTime(),
    title,
  });

  try {
    writeFile(outPath, markdown);
  } catch (error) {
    const message = `Export failed to write ${outPath}: ${String(error)}`;
    deps.notify(message, "error");
    return { ok: false, summary: message };
  }

  const lines = [
    `Project memory exported to ${outPath}`,
    "",
    `- sessions scanned: ${stats.sessionsConsidered} (${stats.filesWithMarkers} with memory entries)`,
    `- observations: ${stats.observationsTotal} → ${stats.observationsRendered} rendered (${stats.duplicatesCollapsed} duplicates collapsed, ${stats.observationsFiltered} below viability gate${stats.suppressedByReflections > 0 ? `, ${stats.suppressedByReflections} covered by reflections` : ""})`,
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

  const summary = lines.filter((l) => l !== null).join("\n");
  deps.sendMessage({
    customType: "blackhole-export",
    content: summary,
    display: true,
  });
  return { ok: true, summary, outPath };
}

export const registerBlackholeExportCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("blackhole-export", {
    description:
      "Export distilled project memory (observations/reflections from past sessions) to markdown. Usage: /blackhole-export [out:<path>.md] [days:<N>] [mode:distilled|timeline]. If no out: is provided, writes to the project local cwd.",
    handler: async (args: string, ctx) => {
      await runBlackholeExport(args, {
        cwd: ctx.cwd,
        getSessionFile: () => ctx.sessionManager.getSessionFile(),
        agentDir: getAgentDir(),
        notify: (message, type) => ctx.ui.notify(message, type),
        sendMessage: (message) => pi.sendMessage(message),
      });
    },
  });
};

/** CLI flag name for headless project-memory exports (cron/systemd timers). */
export const BLACKHOLE_EXPORT_FLAG = "blackhole-export";

/**
 * Headless export body: run the shared core, mirror the outcome to stdio, and
 * shut down. Never rejects — every failure path (stale ctx, parse/validation,
 * IO) ends in `console.error` + `process.exitCode = 1` so schedulers see it.
 *
 * Host behavior this relies on (verified against pi 0.87.0; see
 * work_docs/plan-extract-timeline.md §14):
 * - `session_start` handlers are awaited by `bindExtensions`, so returning
 *   this promise keeps the process alive until the write finishes.
 * - `ctx.ui.notify` is a host no-op without a TUI, hence the stdout summary.
 * - In print mode the host redirects `process.stdout` to stderr
 *   (`takeOverStdout`), so `console.log` lands in cron-captured stderr there;
 *   the `.md` file itself is the machine-readable artifact either way.
 * - `ctx.shutdown()` is a no-op in print mode (no `shutdownHandler` bound);
 *   the process exits naturally when print mode returns. It is still called
 *   so flag runs from interactive mode terminate instead of lingering.
 * - A throwing `session_start` handler only routes to the host `onError`
 *   log — it cannot change the process exit code — hence `process.exitCode`.
 */
async function runHeadlessBlackholeExport(ctx: any, argsString: string): Promise<void> {
  let result: BlackholeExportResult;
  try {
    result = await runBlackholeExport(argsString, {
      cwd: ctx.cwd,
      getSessionFile: () => ctx.sessionManager?.getSessionFile?.() ?? undefined,
      agentDir: getAgentDir(),
      notify: (message, type) => {
        // Headless has no TUI attached, so the host notify is best-effort
        // only. Every terminal outcome below produces `result.summary`,
        // printed exactly once after the run — the single cron-observable
        // line(s). Progress notifies stay silent headless.
        try {
          ctx.ui?.notify?.(message, type ?? "info");
        } catch {
          // Stale headless ctx — the summary print below stays durable.
        }
      },
      // Headless runs have no transcript to update, and a per-run receipt
      // would append one entry to the session file on every cron tick.
      sendMessage: () => {},
    });
  } catch (error) {
    console.error(
      `[blackhole-export] headless export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    try {
      ctx.shutdown();
    } catch {
      // Stale ctx — the process still exits on its own.
    }
    return;
  }
  console.log(result.summary);
  if (!result.ok) {
    process.exitCode = 1;
  }
  try {
    ctx.shutdown();
  } catch {
    // Stale ctx — the process still exits on its own.
  }
}

export const registerBlackholeExportFlag = (pi: ExtensionAPI) => {
  pi.registerFlag(BLACKHOLE_EXPORT_FLAG, {
    type: "string",
    description:
      'Run a headless project-memory export with /blackhole-export argument grammar, then exit. Example: --blackhole-export "days:7 mode:timeline out:memory/weekly.md"',
  });
  // Same stale-ctx discipline as the migration-notice hook in index.ts: the
  // async body is guarded and catch-terminated so a headless export can never
  // surface an unhandled rejection. Returning the promise lets the host
  // (which awaits session_start handlers) hold the process open until the
  // write finishes.
  pi.on("session_start", (_event: unknown, ctx: any) => {
    let flagValue: unknown;
    try {
      flagValue = pi.getFlag(BLACKHOLE_EXPORT_FLAG);
    } catch {
      return;
    }
    if (typeof flagValue !== "string" || flagValue.length === 0) {
      return;
    }
    return runHeadlessBlackholeExport(ctx, flagValue).catch(() => {
      // Terminal guard: runHeadlessBlackholeExport maps every failure to
      // stderr + process.exitCode already, so reaching here would be a coding
      // bug. Never let it escape as an unhandled rejection.
      try {
        process.exitCode = 1;
      } catch {
        // No process global to signal through — nothing left to do.
      }
    });
  });
};
