/**
 * /blackhole-memory command — shows memory pipeline status and content.
 *
 * Created by pi-vcc-om. Replaces OM's standalone /om-status and /om-view.
 * Usage: /blackhole-memory [status|view|full]
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../om/clipboard.js";
import type { Runtime } from "../om/runtime.js";
import {
  diffProjection,
  entryIndexForId,
  foldLedger,
  fullProjection,
  observationToSummaryLine,
  rawTokensAfterIndex,
  rawTokensSinceLastCompaction,
  realContextTokens,
  reflectionToSummaryLine,
  visibleProjection,
  type CountBasis,
  type Entry,
  type Observation,
  type Projection,
} from "../om/ledger/index.js";
import {
  measureDropperDue,
  measureObserverDue,
  measureReflectorDue,
  resolveCompactThreshold,
  resolveTriggerThresholds,
} from "../om/due.js";
import {
  resolveObserverChunkMaxTokens,
  resolveObservationsPoolMaxTokens,
  resolveSessionContextWindow,
  resolveWorkerWindow,
} from "../om/model-budget.js";
import { readPendingState } from "../om/pending.js";
import { observationLineTokenCount } from "../om/tokens.js";
import { isManualMode } from "../core/unified-config.js";

function firstArg(args: unknown): string | undefined {
  if (Array.isArray(args))
    return typeof args[0] === "string" ? args[0] : undefined;
  if (typeof args === "string") return args.trim().split(/\s+/)[0];
  if (args && typeof args === "object" && "mode" in args) {
    const mode = (args as { mode?: unknown }).mode;
    return typeof mode === "string" ? mode : undefined;
  }
  return undefined;
}

function pct(current: number, total: number): number {
  return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
  return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function lineBasedTokenSum(items: Observation[]): number {
  return items.reduce((sum, item) => sum + observationLineTokenCount(item), 0);
}

function addedSuffix(count: number): string | undefined {
  return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
  return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(
  line: string,
  suffixes: (string | undefined)[],
): string {
  const rendered = suffixes.filter((s): s is string => s !== undefined);
  return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

function renderList<T>(
  items: T[],
  render: (item: T) => string,
  empty: string,
): string {
  return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(
  projection: Projection,
  emptyScope: "visible" | "recorded",
): string {
  return [
    "── Reflections ──",
    renderList(
      projection.reflections,
      reflectionToSummaryLine,
      `No ${emptyScope} reflections.`,
    ),
    "",
    "── Observations ──",
    renderList(
      projection.observations,
      observationToSummaryLine,
      `No ${emptyScope} observations.`,
    ),
  ].join("\n");
}

export function registerMemoryCommand(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  pi.registerCommand("blackhole-memory", {
    description:
      "Show memory pipeline status & token counters. /blackhole-memory [view] visible observations & reflections, [full] complete recorded memory (copies to clipboard).",
    handler: async (args, ctx) => {
      runtime.ensureConfig(ctx.cwd, (msg) => ctx.ui?.notify?.(msg, "warning"));
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const sessionId = ctx.sessionManager.getSessionId();
      const mode = firstArg(args);

      // /blackhole-memory full — show full recorded memory + copy to clipboard
      if (mode === "full") {
        const projection = fullProjection(entries);
        const output = renderContentOnlyProjection(projection, "recorded");
        const copied = await copyTextToClipboard(output).catch(() => false);
        ctx.ui.notify(
          copied
            ? `${output}\n\nCopied to clipboard.`
            : `${output}\n\nFailed to copy to clipboard.`,
          "info",
        );
        return;
      }

      // /blackhole-memory view — show visible memory + copy to clipboard
      if (mode === "view") {
        const projection = visibleProjection(entries);
        const output = renderContentOnlyProjection(projection, "visible");
        const copied = await copyTextToClipboard(output).catch(() => false);
        ctx.ui.notify(
          copied
            ? `${output}\n\nCopied to clipboard.`
            : `${output}\n\nFailed to copy to clipboard.`,
          "info",
        );
        return;
      }

      // /blackhole-memory (no args) — show status
      if (mode && mode !== "status") {
        ctx.ui.notify("Usage: /blackhole-memory [status|view|full]", "info");
        return;
      }

      const folded = foldLedger(entries);
      const visible = visibleProjection(entries);
      const full = fullProjection(entries);
      const drift = diffProjection(visible, full);

      const visibleObservationTokens = lineBasedTokenSum(visible.observations);
      const visibleReflectionTokens = tokenSum(visible.reflections);
      const observationLine = appendSuffixes(
        `Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${visible.observations.length} visible`,
        [
          addedSuffix(drift.observationsOnlyInFull.length),
          removedSuffix(drift.droppedOnlyInFull.length),
        ],
      );
      const reflectionLine = appendSuffixes(
        `Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible`,
        [addedSuffix(drift.reflectionsOnlyInFull.length)],
      );
      const dueCtx = {
        model: ctx.model as { contextWindow?: number },
        getContextUsage: ctx.getContextUsage,
      };
      const sessionWindow = resolveSessionContextWindow(
        dueCtx.model,
        dueCtx.getContextUsage,
      );
      const thresholds = resolveTriggerThresholds(
        runtime.config,
        sessionWindow,
      );
      let obsProgress = 0;
      let reflectionProgress = 0;
      let dropProgress = 0;
      let obsBasis: CountBasis = "estimate";
      let reflectBasis: CountBasis = "estimate";
      let dropBasis: CountBasis = "estimate";
      {
        const obsMeasurement = measureObserverDue(entries, runtime, dueCtx);
        const reflectMeasurement = measureReflectorDue(
          entries,
          runtime,
          dueCtx,
        );
        const dropMeasurement = measureDropperDue(entries, runtime, dueCtx);
        obsProgress = obsMeasurement.progress;
        reflectionProgress = reflectMeasurement.progress;
        dropProgress = dropMeasurement.progress;
        obsBasis = obsMeasurement.basis;
        reflectBasis = reflectMeasurement.basis;
        dropBasis = dropMeasurement.basis;
      }
      const compactionReal = realContextTokens(entries);
      const compactionProgress =
        compactionReal ?? rawTokensSinceLastCompaction(entries);
      const compactionBasis: CountBasis =
        compactionReal !== undefined ? "usage" : "estimate";
      const compactThreshold = resolveCompactThreshold(
        runtime.config,
        sessionWindow,
      );

      // In manual mode, pending coversUpToId entries act as virtual coverage markers
      // that aren't reflected in the branch. Adjust accumulated counts accordingly
      // (the rawTokensAfterIndex override is a chars/4 estimate).
      if (isManualMode(runtime.config)) {
        const pending = readPendingState(sessionId);
        if (pending.observation?.coversUpToId) {
          const idx = entryIndexForId(
            entries,
            pending.observation.coversUpToId,
          );
          if (idx >= 0) {
            obsProgress = rawTokensAfterIndex(entries, idx);
            obsBasis = "estimate";
          }
        }
        if (pending.reflection?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
          if (idx >= 0) {
            reflectionProgress = rawTokensAfterIndex(entries, idx);
            reflectBasis = "estimate";
          }
        }
        if (pending.dropped?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
          if (idx >= 0) {
            dropProgress = rawTokensAfterIndex(entries, idx);
            dropBasis = "estimate";
          }
        }
      }

      const passiveLines =
        runtime.config.passive === true
          ? [
              "── Mode ──",
              "Passive: automatic memory workers and auto-compaction disabled",
              "",
            ]
          : [];

      const poolMax = resolveObservationsPoolMaxTokens(
        runtime.config.observationsPoolMaxTokens,
        sessionWindow,
      );
      const estPrefix = (basis: CountBasis): string =>
        basis === "estimate" ? "~" : " ";
      const anyEstimate =
        obsBasis === "estimate" ||
        reflectBasis === "estimate" ||
        dropBasis === "estimate" ||
        compactionBasis === "estimate";
      const manual = isManualMode(runtime.config);
      const lines = [
        ...passiveLines,
        "── Memory ──",
        observationLine,
        reflectionLine,
        "",
        "── Pipeline ──",
        "Transcript accumulated since last run. Triggers when exceeding threshold.",
        `Observer:       ${estPrefix(obsBasis)}${obsProgress.toLocaleString()} / ${thresholds.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, thresholds.observeAfterTokens)}%)`,
        `Reflector:      ${estPrefix(reflectBasis)}${reflectionProgress.toLocaleString()} / ${thresholds.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, thresholds.reflectAfterTokens)}%)`,
        `Dropper:        pool ${pct(visibleObservationTokens, poolMax)}% — prunes at ≥${Math.round(runtime.config.dropperPoolFullnessThreshold * 100)}% pool (${estPrefix(dropBasis)}${dropProgress.toLocaleString()}/${thresholds.reflectAfterTokens.toLocaleString()} new tokens)`,
        `Compaction:     ${estPrefix(compactionBasis)}${compactionProgress.toLocaleString()}${manual ? " tokens [manual]" : ` / ${compactThreshold.toLocaleString()} tokens (${pct(compactionProgress, compactThreshold)}%)`}`,
        `Obs pool:       ~${visibleObservationTokens.toLocaleString()} / ${poolMax.toLocaleString()} tokens (${pct(visibleObservationTokens, poolMax)}%)`,
        `Reflect pool:   ~${visibleReflectionTokens.toLocaleString()} tokens`,
        ...(anyEstimate
          ? [
              "",
              'Basis: usage | estimate — "~" marks chars/4 estimates; unmarked counters use real model usage.',
            ]
          : []),
      ];

      // Show pending data when manual mode is active
      if (isManualMode(runtime.config)) {
        const pending = readPendingState(sessionId);
        const hasObs = !!pending.observation;
        const hasRef = !!pending.reflection;
        const hasDrop = !!pending.dropped;
        if (hasObs || hasRef || hasDrop) {
          lines.push("", "── Pending (manual mode) ──");
          if (hasObs) lines.push("Observation:  waiting in pending.json");
          if (hasRef) lines.push("Reflection:   waiting in pending.json");
          if (hasDrop) lines.push("Dropper:      waiting in pending.json");
          const preambleCap =
            runtime.config.observerPreambleMaxTokens > 0
              ? runtime.config.observerPreambleMaxTokens
              : Math.round(
                  resolveObserverChunkMaxTokens(
                    runtime.config.observerChunkMaxTokens,
                    resolveWorkerWindow(
                      runtime.config.observerModel,
                      sessionWindow,
                    ),
                  ) * 0.3,
                );
          const resolvedChunkCap = resolveObserverChunkMaxTokens(
            runtime.config.observerChunkMaxTokens,
            resolveWorkerWindow(runtime.config.observerModel, sessionWindow),
          );
          const pctNote =
            runtime.config.observerPreambleMaxTokens > 0
              ? ""
              : ` (30% of ${resolvedChunkCap.toLocaleString()} chunk)`;
          lines.push(
            `Preamble cap: ${preambleCap.toLocaleString()} tokens for observations${pctNote}`,
          );
          lines.push("Run /blackhole to flush and compact.");
        }
      }

      if (
        runtime.consolidationInFlight ||
        runtime.compactInFlight ||
        runtime.compactHookInFlight
      ) {
        lines.push("", "── In flight ──");
        if (runtime.consolidationInFlight) {
          const phase = runtime.consolidationPhase
            ? ` (${runtime.consolidationPhase})`
            : "";
          lines.push(`Consolidation: running${phase}`);
        }
        if (runtime.compactInFlight) lines.push("Auto-compaction: running");
        if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
      }

      if (
        runtime.lastObserverError ||
        runtime.lastReflectorError ||
        runtime.lastDropperError
      ) {
        lines.push("", "── Last error ──");
        if (runtime.lastObserverError)
          lines.push(`Observer: ${runtime.lastObserverError}`);
        if (runtime.lastReflectorError)
          lines.push(`Reflector: ${runtime.lastReflectorError}`);
        if (runtime.lastDropperError)
          lines.push(`Dropper: ${runtime.lastDropperError}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
