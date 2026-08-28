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
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerCompactFailedHook } from "./src/hooks/compact-failed.js";
import { registerCompactionContextHook } from "./src/hooks/compaction-context.js";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerMemoryCommand } from "./src/commands/memory";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";
import { captureRegisteredProviderStreams } from "./src/om/provider-stream.js";
import { installHostInlineCompactionAdapter } from "./src/om/inline-compaction.js";

export default async (pi: ExtensionAPI) => {
  // Resolve the host's AgentSession identity before this factory returns. Local
  // package development can otherwise patch a duplicate devDependency module.
  // The adapter is reload-idempotent and fails closed on unknown Pi internals.
  await installHostInlineCompactionAdapter();
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
  const providerStreams: Map<string, Function> = ((globalThis as any)[
    PROVIDER_STREAMS_KEY
  ] ??= new Map());
  pi.on("agent_start", (_event: unknown, ctx: any) => {
    captureRegisteredProviderStreams(ctx.modelRegistry, providerStreams);
  });

  scaffoldSettings();

  const omRuntime = new Runtime();

  // Observational memory: background consolidation pipeline
  registerConsolidationTrigger(pi, omRuntime); // agent_start + turn_end → observer/reflector/dropper
  registerCompactionTrigger(pi, omRuntime); // turn_end + agent_end → auto-compaction

  // Pi-vcc: compaction + om injection
  registerBeforeCompactHook(pi, omRuntime); // session_before_compact → pi-vcc + om content
  registerCompactFailedHook(pi, omRuntime); // session_compact_failed → failure visibility + compactInFlight guard (pi >= 0.84.3)
  registerCompactionContextHook(pi, omRuntime); // context → immutable append segment projection

  // Commands
  registerPiVccCommand(pi, omRuntime); // /pi-vcc (needs runtime for noAutoCompact flush)
  registerMemoryCommand(pi, omRuntime); // /blackhole-memory [status|view|full]
  registerVccRecallCommand(pi); // /blackhole-recall <query>

  // Tools
  registerRecallTool(pi); // unified recall (#N + [12char])
};
