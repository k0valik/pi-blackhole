/**
 * Pi-vcc settings — reads from unified pi-blackhole/pi-blackhole-config.json.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/settings.ts)
 * Modified by pi-vcc-om: loadSettings wraps loadUnifiedConfig.
 */
import { loadUnifiedConfig, scaffoldConfig } from "./unified-config.js";

export interface PiVccSettings {
	/** @deprecated Use compactionEngine instead. */
	overrideDefaultCompaction: boolean;
	/** @deprecated Use compaction instead. */
	noAutoCompact: boolean;
	/** @deprecated Use compaction + memory instead. */
	passive: boolean;
	/** Write debug snapshots to /tmp/pi-blackhole-debug.json. */
	debug: boolean;
	/** Unified compaction control: "auto" | "manual" | "off". */
	compaction: "auto" | "manual" | "off";
	/** Compaction engine: "blackhole" | "pi-default". */
	compactionEngine: "blackhole" | "pi-default";
	/** Visible tail behavior: "pi-default" | "minimal". */
	tailBehavior: "pi-default" | "minimal";
}

export function loadSettings(): PiVccSettings {
	const config = loadUnifiedConfig(process.cwd());
	return {
		overrideDefaultCompaction: config.overrideDefaultCompaction ?? false,
		noAutoCompact: config.noAutoCompact ?? false,
		passive: config.passive ?? false,
		debug: config.debug,
		compaction: config.compaction,
		compactionEngine: config.compactionEngine,
		tailBehavior: config.tailBehavior,
	};
}

export function scaffoldSettings(): void {
	scaffoldConfig();
}


