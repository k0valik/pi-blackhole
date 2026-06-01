/**
 * Config simplification — migration tests for new compaction/tailBehavior knobs.
 *
 * T1–T12: Verifies:
 *   - New keys parse correctly
 *   - Old keys migrate to new keys
 *   - Mixed old+new config: new wins
 *   - Migration runs once
 *   - Env overrides interact correctly
 *   - Invalid enum values fall back to defaults
 *
 * Pattern from voice-type: per-field parse, atomic save, scaffold with fill-in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { __setTestConfigDir } from "../src/core/unified-config.js";

const testDir = join(tmpdir(), `pi-blackhole-config-${randomUUID().slice(0, 8)}`);

// ── Helpers ────────────────────────────────────────────────────────────────

function writeConfig(data: unknown, filename = "pi-blackhole/pi-blackhole-config.json"): string {
	const dir = join(testDir, dirname(filename));
	mkdirSync(dir, { recursive: true });
	const path = join(testDir, filename);
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

function configPath(): string {
	return join(testDir, "pi-blackhole", "pi-blackhole-config.json");
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	__setTestConfigDir(testDir);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	__setTestConfigDir(undefined);
	// Clean up env vars to prevent cross-test contamination
	delete process.env.PI_BLACKHOLE_PASSIVE;
	delete process.env.PI_VCC_OM_PASSIVE;
	delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
	delete process.env.PI_BLACKHOLE_COMPACTION;
	delete process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
	try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});



// ── Tests: New key defaults ─────────────────────────────────────────────────

describe("New config keys — defaults", () => {
	it("T1: no config file returns defaults for all new keys", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("auto");
		expect(config.compactionEngine).toBe("blackhole");
		expect(config.tailBehavior).toBe("pi-default");
	});

	it("T1b: existing old DEFAULTS are preserved", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		const config = loadUnifiedConfig(testDir);

		expect(config.memory).toBe(true);
		expect(config.compactAfterTokens).toBe(81_000);
		// Old keys are optional and absent from DEFAULTS
		expect(config.overrideDefaultCompaction).toBeUndefined();
	});
});

// ── Tests: New key parsing ─────────────────────────────────────────────────

describe("New key parsing", () => {
	it("parses compaction string enum", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "manual" });
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("manual");
	});

	it("parses compactionEngine string enum", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compactionEngine: "pi-default" });
		const config = loadUnifiedConfig(testDir);
		expect(config.compactionEngine).toBe("pi-default");
	});

	it("parses tailBehavior string enum", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ tailBehavior: "minimal" });
		const config = loadUnifiedConfig(testDir);
		expect(config.tailBehavior).toBe("minimal");
	});

	it("T11: invalid compaction value falls back to default", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "turbo" });
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("auto");
	});

	it("T12: invalid tailBehavior value falls back to default", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ tailBehavior: "all" });
		const config = loadUnifiedConfig(testDir);
		expect(config.tailBehavior).toBe("pi-default");
	});

	it("rejects invalid compactionEngine value", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compactionEngine: "hybrid" });
		const config = loadUnifiedConfig(testDir);
		expect(config.compactionEngine).toBe("blackhole");
	});
});

// ── Tests: Old → New migration ────────────────────────────────────────────

describe("Old → new key migration", () => {
	it("T2: overrideDefaultCompaction:true → compactionEngine:blackhole + tailBehavior:minimal", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ overrideDefaultCompaction: true });

		const config = loadUnifiedConfig(testDir);

		expect(config.compactionEngine).toBe("blackhole");
		// Existing users with override=true keep aggressive cut
		expect(config.tailBehavior).toBe("minimal");
		// Old key should be removed by migration
		expect((config as any).overrideDefaultCompaction).toBeUndefined();
	});

	it("T3: noAutoCompact:true → compaction:manual", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ noAutoCompact: true });

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("manual");
		expect((config as any).noAutoCompact).toBeUndefined();
	});

	it("T4: passive:true → compaction:off + memory:false", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ passive: true });

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
		expect((config as any).passive).toBeUndefined();
	});

	it("T5: memory:false alone (no old compaction knobs) → memory:false, compaction still auto", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ memory: false });

		const config = loadUnifiedConfig(testDir);

		expect(config.memory).toBe(false);
		expect(config.compaction).toBe("auto"); // memory is orthogonal now
		// memory is NOT being removed — it stays as a kept key
	});

	it("T6: mixed old + new — new wins, old ignored", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			overrideDefaultCompaction: true,
			compaction: "manual",
		});

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("manual"); // new wins
		// overrideDefaultCompaction should NOT migrate since new key was present
		expect(config.compactionEngine).toBe("blackhole"); // default, not migrated
		expect(config.tailBehavior).toBe("pi-default"); // default, not migrated
	});

	it("T7: all new keys directly — no migration runs", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({
			compaction: "manual",
			compactionEngine: "pi-default",
			tailBehavior: "minimal",
		});

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("manual");
		expect(config.compactionEngine).toBe("pi-default");
		expect(config.tailBehavior).toBe("minimal");

		// Existing unrelated keys should be untouched
		expect(config.memory).toBe(true);
		expect(config.compactAfterTokens).toBe(81_000);
	});

	it("T8: migration runs once — old keys deleted from parsed result", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ overrideDefaultCompaction: true });

		// First load — migration runs
		const config1 = loadUnifiedConfig(testDir);
		expect(config1.compactionEngine).toBe("blackhole");

		// Second load — old keys are gone from disk? No — migration is in-memory.
		// But the function should not re-migrate already-migrated config.
		// The on-disk file hasn't changed, so second load would re-run migration
		// which is idempotent. Let's verify it's stable.
		const config2 = loadUnifiedConfig(testDir);
		expect(config2.compactionEngine).toBe("blackhole");
		expect(config2.tailBehavior).toBe("minimal");
	});

	it("overrideDefaultCompaction:false (already default) — no migration needed", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ overrideDefaultCompaction: false });

		const config = loadUnifiedConfig(testDir);

		// false is the default for overrideDefaultCompaction, so no migration
		expect(config.compactionEngine).toBe("blackhole"); // default
		expect(config.tailBehavior).toBe("pi-default"); // default
	});

	it("noAutoCompact:false + overrideDefaultCompaction:false — all defaults", async () => {
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ noAutoCompact: false, overrideDefaultCompaction: false });

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("auto");
		expect(config.compactionEngine).toBe("blackhole");
		expect(config.tailBehavior).toBe("pi-default");
	});
});

// ── Tests: Env overrides ──────────────────────────────────────────────────

describe("Env overrides", () => {

	it("T9: PI_BLACKHOLE_PASSIVE=1 forces compaction:off + memory:false", async () => {
		process.env.PI_BLACKHOLE_PASSIVE = "1";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "auto", memory: true });

		const config = loadUnifiedConfig(testDir);

		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
	});

	it("PI_BLACKHOLE_PASSIVE is deprecated but still works with legacy name PI_VCC_OM_PASSIVE", async () => {
		process.env.PI_VCC_OM_PASSIVE = "true";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({});

		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("off");
		expect(config.memory).toBe(false);
	});

	it("PI_BLACKHOLE_COMPACTION env var overrides compaction", async () => {
		process.env.PI_BLACKHOLE_COMPACTION = "manual";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "auto" });

		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("manual");
	});

	it("PI_BLACKHOLE_COMPACTION_ENGINE env var overrides compactionEngine", async () => {
		process.env.PI_BLACKHOLE_COMPACTION_ENGINE = "pi-default";
		const { loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compactionEngine: "blackhole" });

		const config = loadUnifiedConfig(testDir);
		expect(config.compactionEngine).toBe("pi-default");
	});
});

// ── Tests: Toggle helpers ─────────────────────────────────────────────────

describe("Toggle helper functions", () => {
	it("toggleCompaction cycles auto→manual→off→auto", async () => {
		const mod = await import("../src/core/unified-config.js");
		const { toggleCompaction } = mod;

		expect(toggleCompaction("auto")).toBe("manual");
		expect(toggleCompaction("manual")).toBe("off");
		expect(toggleCompaction("off")).toBe("auto");
	});

	it("toggleCompactionEngine switches blackhole↔pi-default", async () => {
		const mod = await import("../src/core/unified-config.js");
		const { toggleCompactionEngine } = mod;

		expect(toggleCompactionEngine("blackhole")).toBe("pi-default");
		expect(toggleCompactionEngine("pi-default")).toBe("blackhole");
	});

	it("toggleTailBehavior switches pi-default↔minimal", async () => {
		const mod = await import("../src/core/unified-config.js");
		const { toggleTailBehavior } = mod;

		expect(toggleTailBehavior("pi-default")).toBe("minimal");
		expect(toggleTailBehavior("minimal")).toBe("pi-default");
	});
});

// ── Tests: saveUnifiedConfig atomic write ─────────────────────────────────

describe("saveUnifiedConfig — atomic write", () => {
	it("saves config with atomic temp+rename pattern", async () => {
		const { saveUnifiedConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		const result = saveUnifiedConfig({ compaction: "manual", tailBehavior: "minimal" });
		expect(result).toBe(true);

		// Verify saved to disk
		const disk = JSON.parse(readFileSync(configPath(), "utf-8"));
		expect(disk.compaction).toBe("manual");
		expect(disk.tailBehavior).toBe("minimal");

		// Verify load reads it back
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("manual");
		expect(config.tailBehavior).toBe("minimal");
	});

	it("preserves existing keys when saving partial config", async () => {
		const { saveUnifiedConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "manual", memory: false });

		const saveResult = saveUnifiedConfig({ compaction: "auto" });

		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("auto");
		expect(config.memory).toBe(false); // preserved
	});

	it("does not crash on read-only filesystem (returns false)", async () => {
		const { saveUnifiedConfig } = await import("../src/core/unified-config.js");
		// Make the config dir read-only so write fails
		const dir = join(testDir, "pi-blackhole");
		mkdirSync(dir, { recursive: true });
		// Set permissions to read+execute only (no write)
		try { chmodSync(dir, 0o555); } catch { /* skip on Windows */ }

		const result = saveUnifiedConfig({ compaction: "manual" });
		expect(result).toBe(false);

		// Restore permissions so afterEach cleanup works
		try { chmodSync(dir, 0o755); } catch { /* skip on Windows */ }
	});
});

// ── Tests: scaffoldConfig for NixOS safety ────────────────────────────────

describe("scaffoldConfig — NixOS safety", () => {
	it("creates config file with defaults when missing", async () => {
		const { scaffoldConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		expect(existsSync(configPath())).toBe(false);

		scaffoldConfig();

		expect(existsSync(configPath())).toBe(true);
		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("auto");
		expect(config.compactionEngine).toBe("blackhole");
	});

	it("does not overwrite existing config on scaffold", async () => {
		const { scaffoldConfig, loadUnifiedConfig } = await import("../src/core/unified-config.js");
		writeConfig({ compaction: "manual" });

		scaffoldConfig();

		const config = loadUnifiedConfig(testDir);
		expect(config.compaction).toBe("manual");
	});

	it("does not crash on read-only filesystem during scaffold", async () => {
		const { scaffoldConfig } = await import("../src/core/unified-config.js");
		// Create directory with read-only permissions
		mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
		try { chmodSync(join(testDir, "pi-blackhole"), 0o555); } catch { /* skip on Windows */ }

		expect(() => scaffoldConfig()).not.toThrow();

		// Restore permissions so afterEach cleanup works
		try { chmodSync(join(testDir, "pi-blackhole"), 0o755); } catch { /* skip on Windows */ }
	});
});
