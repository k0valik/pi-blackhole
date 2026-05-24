/**
 * Pi-vcc settings — reads from unified pi-blackhole/pi-blackhole-config.json.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/settings.ts)
 * Modified by pi-vcc-om: loadSettings wraps loadUnifiedConfig.
 */
import { loadUnifiedConfig, scaffoldConfig } from "./unified-config.js";

export interface PiVccSettings {
	/** When true, pi-vcc handles all compactions. */
	overrideDefaultCompaction: boolean;
	/** Write debug snapshots to /tmp/pi-blackhole-debug.json. */
	debug: boolean;
}

export function loadSettings(): PiVccSettings {
	const config = loadUnifiedConfig(process.cwd());
	return {
		overrideDefaultCompaction: config.overrideDefaultCompaction,
		debug: config.debug,
	};
}

export function scaffoldSettings(): void {
	scaffoldConfig();
}


