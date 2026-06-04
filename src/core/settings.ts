/**
 * Scaffold the pi-blackhole config file on disk.
 *
 * Only holds scaffoldSettings(); config loading/parsing happens in unified-config.ts.
 */
import { scaffoldConfig } from "./unified-config.js";

export function scaffoldSettings(): void {
	scaffoldConfig();
}


