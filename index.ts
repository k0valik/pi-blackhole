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
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerMemoryCommand } from "./src/commands/memory";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";

export default (pi: ExtensionAPI) => {
	scaffoldSettings();

	const omRuntime = new Runtime();

	// Observational memory: background consolidation pipeline
	registerConsolidationTrigger(pi, omRuntime);      // agent_start + turn_end → observer/reflector/dropper
	registerCompactionTrigger(pi, omRuntime);         // agent_end → auto-compaction

	// Pi-vcc: compaction + om injection
	registerBeforeCompactHook(pi, omRuntime);          // session_before_compact → pi-vcc + om content

	// Commands
	registerPiVccCommand(pi, omRuntime);               // /pi-vcc (needs runtime for noAutoCompact flush)
	registerMemoryCommand(pi, omRuntime);              // /blackhole-memory [status|view|full]

	// Tools
	registerRecallTool(pi);                            // unified recall (#N + [12char])
};
