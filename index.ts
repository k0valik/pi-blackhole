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
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerConsolidationTrigger } from "./src/om/consolidation.js";
import { registerCompactionTrigger } from "./src/om/compaction-trigger.js";
import { registerRecallTool } from "./src/tools/recall";
import { Runtime } from "./src/om/runtime.js";

export default (pi: ExtensionAPI) => {
	// ── Bridge: capture custom provider stream functions for jiti-loaded agents ──
	// pi-blackhole's consolidation agents are loaded via jiti with moduleCache: false,
	// which creates a separate pi-ai instance whose apiProviderRegistry lacks custom
	// providers (e.g., claude-bridge registered by other extensions). This bridge stores
	// streamSimple functions in a Symbol.for() global so agents can access them without
	// going through pi-ai's registry.
	//
	// There are two mechanisms:
	// 1. Wrap pi.registerProvider to capture streamSimple at registration time.
	//    This handles providers registered AFTER our factory runs.
	// 2. On agent_start, scan modelRegistry.registeredProviders for any providers
	//    that registered BEFORE our factory ran (different extension load order).
	const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
	const providerStreams: Map<string, Function> = (globalThis as any)[PROVIDER_STREAMS_KEY] ??= new Map();

	const origRegisterProvider = pi.registerProvider.bind(pi);
	pi.registerProvider = (name: string, config: any) => {
		if (config && config.streamSimple && config.api) {
			providerStreams.set(config.api, config.streamSimple);
		}
		origRegisterProvider(name, config);
	};

	// Fallback: on agent_start, capture providers that registered before our wrapper
	// (handles the case where pi-blackhole loads after another provider extension).
	pi.on("agent_start", (_event: unknown, ctx: any) => {
		if (providerStreams.size > 0) return; // Already have captures
		// modelRegistry.registeredProviders is declared private in TypeScript but is a
		// regular JS class field at runtime. We access it via bracket notation for
		// future-proofing against potential #private migration.
		const registry = (ctx as any)?.modelRegistry;
		const registered: Map<string, any> | undefined = registry?.["registeredProviders"];
		if (registered && typeof registered.forEach === "function") {
			registered.forEach((config: any, _name: string) => {
				if (config && config.streamSimple && config.api && !providerStreams.has(config.api)) {
					providerStreams.set(config.api, config.streamSimple);
				}
			});
		}
	});

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
	registerVccRecallCommand(pi);                        // /blackhole-recall <query>

	// Tools
	registerRecallTool(pi);                            // unified recall (#N + [12char])
};
