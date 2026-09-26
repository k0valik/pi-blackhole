/**
 * Unified entry point. Registers all pi-vcc + observational-memory
 * commands, hooks, and tools.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/index.ts)
 *           https://github.com/sting8k/pi-vcc (index.ts)
 * Merged and extended by pi-vcc-om.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { migrateConfigFiles } from "./src/core/config-migration/index.js";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerCompactFailedHook } from "./src/hooks/compact-failed.js";
import { registerCompactionContextHook } from "./src/hooks/compaction-context.js";
import { registerPreCompactionOutput } from "./src/hooks/cosmetic-output.js";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerMemoryCommand } from "./src/commands/memory";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerBlackholeExportCommand } from "./src/commands/blackhole-export";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.js";
import { registerStatusBar } from "./src/om/status-bar.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";
import { captureRegisteredProviderStreams } from "./src/om/provider-stream.js";
import { installHostInlineCompactionAdapter } from "./src/om/inline-compaction.js";

export default async (pi: ExtensionAPI) => {
  // Resolve the host's AgentSession identity before this factory returns. Local
  // package development can otherwise patch a duplicate devDependency module.
  // The adapter is reload-idempotent and fails closed on unknown Pi internals.
  const inlineCompactionAdapterStatus = await installHostInlineCompactionAdapter();
  // ── Bridge: capture custom provider stream functions for jiti-loaded agents ──
  // pi-blackhole's consolidation agents are loaded via jiti with moduleCache: false,
  // which creates a separate pi-ai instance whose apiProviderRegistry lacks custom
  // providers (e.g., claude-bridge registered by other extensions). This bridge stores
  // streamSimple functions in a Symbol.for() global so agents can access them without
  // going through pi-ai's registry.
  //
  // Capture custom provider streams from Pi's model registry before each run.
  // This works regardless of extension load order and includes providers added
  // after startup.
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  const providerStreams: Map<string, Function> = ((globalThis as any)[PROVIDER_STREAMS_KEY] ??=
    new Map());
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
  });

  scaffoldSettings();

  // Config-file migration (plan-10): rewrite the global and project config
  // files once per session, before any reader runs, so by the time the modal
  // or the runtime loads them the keys on disk match the keys the code reads.
  // Best-effort: read-only installs and stale ctx must never be fatal (the
  // loader also migrates in memory, so behavior is correct even if this skips).
  // When a migration actually ran, emit the once-per-process release notice
  // (version-gated in src/changelog/migration-notice.ts).
  pi.on("session_start", (_event: unknown, ctx: any) => {
    void (async () => {
      try {
        const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
        const notify = (message: string, level?: "info" | "warning") => {
          if (ctx?.hasUI) ctx.ui?.notify?.(message, level);
        };
        const results = await migrateConfigFiles(cwd, { notify });
        const outcome = results.some((r) => r.persisted)
          ? ("migrated" as const)
          : results.some((r) => r.changed)
            ? ("blocked" as const)
            : ("none" as const);
        const { maybeNotifyConfigMigration } = await import("./src/changelog/migration-notice.js");
        maybeNotifyConfigMigration(ctx, outcome);
      } catch {
        /* migration + notice are best-effort — never fatal */
      }
    })();
  });

  const omRuntime = new Runtime();
  // Carry the startup probe result into the runtime so triggers can explain an
  // unsupported host instead of silently falling back every run.
  omRuntime.inlineCompactionAdapterStatus = inlineCompactionAdapterStatus;

  // Observational memory: background consolidation pipeline
  registerConsolidationTrigger(pi, omRuntime); // agent_start + turn_end → observer/reflector/dropper
  registerCompactionTrigger(pi, omRuntime); // turn_end + agent_end → auto-compaction
  registerStatusBar(pi, omRuntime); // footer gauges (O/P/X) + worker events (config.statusBar)

  // Pi-vcc: compaction + om injection
  registerBeforeCompactHook(pi, omRuntime); // session_before_compact → pi-vcc + om content
  registerCompactFailedHook(pi, omRuntime); // session_compact_failed → failure visibility + compactInFlight guard (pi >= 0.84.3)
  registerCompactionContextHook(pi, omRuntime); // context → immutable append segment projection
  registerPreCompactionOutput(pi, omRuntime); // session_compact → display-only copy of dropped output

  // Commands
  registerPiVccCommand(pi, omRuntime); // /pi-vcc (needs runtime for noAutoCompact flush)
  registerMemoryCommand(pi, omRuntime); // /blackhole-memory [status|view|full]
  registerVccRecallCommand(pi); // /blackhole-recall <query>
  registerBlackholeExportCommand(pi); // /blackhole-export [out:<path>]

  // Tools
  registerRecallTool(pi, omRuntime); // unified recall (#N + [12char]), budget-capped
};
