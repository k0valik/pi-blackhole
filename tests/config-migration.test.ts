/**
 * Config-file migration tests (plan-10 §7).
 *
 * Two layers:
 *  - pure per-step tests over `projectConfig` / `applyConfigMigrations`;
 *  - runner tests over real temp files (two-phase, verification, read-only,
 *    atomicity, idempotence, per-scope).
 *
 * AGENTS T1: the per-step tests fail if a transform is wrong; the runner tests
 * fail if the two-phase/verification guards regress.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CONFIG_VERSION,
  applyConfigMigrations,
  atomicWrite,
  migrateConfigFile,
  migrateConfigFiles,
  projectConfig,
} from "../src/core/config-migration/index.js";
import { __setTestConfigDir } from "../src/core/unified-config.js";

const testDir = join(tmpdir(), `pi-blackhole-migrate-${randomUUID().slice(0, 8)}`);
const GLOBAL = join(testDir, "pi-blackhole", "pi-blackhole-config.json");
const PROJECT = join(testDir, ".pi", "pi-blackhole-config.json");

function writeConfig(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Project + delete in memory (what the runtime loader does). */
function migrated(obj: Record<string, unknown>): Record<string, unknown> {
  return applyConfigMigrations(structuredClone(obj)).config;
}

beforeEach(() => {
  __setTestConfigDir(testDir);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  __setTestConfigDir(undefined);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Per-step: compaction engine fold ────────────────────────────────────────

describe("compaction-engine-fold", () => {
  it("folds compactionEngine:pi-default into compaction:off", () => {
    const c = migrated({ compaction: "auto", compactionEngine: "pi-default" });
    expect(c.compaction).toBe("off");
    expect("compactionEngine" in c).toBe(false);
  });

  it("renames compaction:auto to automatic with the blackhole engine", () => {
    const c = migrated({ compaction: "auto", compactionEngine: "blackhole" });
    expect(c.compaction).toBe("automatic");
    expect("compactionEngine" in c).toBe(false);
  });

  it("removes a stray engine key without changing an explicit manual/off value", () => {
    expect(migrated({ compaction: "manual", compactionEngine: "blackhole" }).compaction).toBe(
      "manual",
    );
    const off = migrated({ compaction: "off", compactionEngine: "pi-default" });
    expect(off.compaction).toBe("off");
    expect("compactionEngine" in off).toBe(false);
  });

  it("skips an unrecognized engine value and reports it", () => {
    const proj = projectConfig({ compactionEngine: "hybrid" });
    expect(proj.warnings.map((w) => w.key)).toContain("compactionEngine");
    expect(proj.config.compactionEngine).toBe("hybrid");
    expect(proj.consumedToDelete).not.toContain("compactionEngine");
  });

  it("is a no-op for an already-migrated file", () => {
    expect(applyConfigMigrations({ compaction: "automatic" }).changed).toBe(false);
  });
});

// ── Per-step: legacy modes ──────────────────────────────────────────────────

describe("legacy-modes", () => {
  it("maps passive:true to off + memory:false", () => {
    const c = migrated({ passive: true, memory: true });
    expect(c.compaction).toBe("off");
    expect(c.memory).toBe(false);
    expect("passive" in c).toBe(false);
  });

  it("maps noAutoCompact:true to manual", () => {
    const c = migrated({ noAutoCompact: true });
    expect(c.compaction).toBe("manual");
    expect("noAutoCompact" in c).toBe(false);
  });

  it("maps overrideDefaultCompaction:true to automatic + minimal tail", () => {
    const c = migrated({ overrideDefaultCompaction: true });
    expect(c.compaction).toBe("automatic");
    expect(c.tailBehavior).toBe("minimal");
    expect("overrideDefaultCompaction" in c).toBe(false);
  });

  it("maps overrideDefaultCompaction:false to off", () => {
    expect(migrated({ overrideDefaultCompaction: false }).compaction).toBe("off");
  });

  it("lets an explicit compaction value win over the legacy keys", () => {
    expect(migrated({ overrideDefaultCompaction: true, compaction: "off" }).compaction).toBe("off");
  });

  it("skips a non-boolean legacy value and reports it", () => {
    const proj = projectConfig({ passive: "yes" });
    expect(proj.warnings.map((w) => w.key)).toContain("passive");
    expect(proj.config.passive).toBe("yes");
    expect(proj.consumedToDelete).not.toContain("passive");
  });
});

// ── Per-step: threshold array ───────────────────────────────────────────────

describe("threshold-array", () => {
  it("sets compactAfterBy=tokens by the old precedence and converts ratio to percent", () => {
    const c = migrated({ compactAfterTokens: 180_000, compactAfterRatio: 0.65 });
    expect(c.compactAfterBy).toBe("tokens");
    expect(c.compactAfterTokens).toBe(180_000);
    expect(c.compactAfterRatio).toBe(65);
  });

  it.each([
    [
      "tokens beats ratio and reserve",
      { compactAfterTokens: 180_000, compactAfterRatio: 0.65, compactReserveTokens: 32_768 },
      "tokens",
    ],
    ["ratio beats reserve", { compactAfterRatio: 0.65, compactReserveTokens: 32_768 }, "percent"],
    [
      "tokens beats reserve",
      { compactAfterTokens: 180_000, compactReserveTokens: 32_768 },
      "tokens",
    ],
  ])("old precedence: %s", (_name, raw, shape) => {
    expect(migrated(raw as Record<string, unknown>).compactAfterBy).toBe(shape);
  });

  it.each([
    [0.5, 50],
    [0.01, 1],
    [0.65, 65],
    [1, 100],
  ])("converts the old fraction %s to %s percent", (fraction, percent) => {
    const c = migrated({ compactAfterRatio: fraction });
    expect(c.compactAfterRatio).toBe(percent);
    expect(c.compactAfterBy).toBe("percent");
  });

  it("sets compactAfterBy=percent for a ratio-only file", () => {
    const c = migrated({ compactAfterRatio: 0.65 });
    expect(c.compactAfterBy).toBe("percent");
    expect(c.compactAfterRatio).toBe(65);
  });

  it("sets compactAfterBy=reserve for a reserve-only file", () => {
    const c = migrated({ compactReserveTokens: 32_768 });
    expect(c.compactAfterBy).toBe("reserve");
    expect(c.compactReserveTokens).toBe(32_768);
  });

  it("drops the legacy 81000 scaffold residue and leaves the shape default", () => {
    const c = migrated({ compactAfterTokens: 81_000 });
    expect("compactAfterTokens" in c).toBe(false);
    expect(c.compactAfterBy).toBeUndefined();
  });

  it("does not re-interpret an already-migrated percent", () => {
    const c = migrated({ compactAfterBy: "percent", compactAfterRatio: 46 });
    expect(c.compactAfterRatio).toBe(46);
  });

  it("skips an unrecognized ratio value and reports it", () => {
    const proj = projectConfig({ compactAfterRatio: 101 });
    expect(proj.warnings.map((w) => w.key)).toContain("compactAfterRatio");
    expect(proj.config.compactAfterRatio).toBe(101);
    expect(proj.consumedToDelete).not.toContain("compactAfterRatio");
  });

  it("treats a 0-valued compactAfterTokens as unset, never invalid", () => {
    // Regression: a 0 sentinel used to abort the whole file, leaving a fraction
    // ratio unconverted and read as a sub-1% percent.
    const proj = projectConfig({ compactAfterTokens: 0, compactAfterRatio: 0.65 });
    expect(proj.warnings).toHaveLength(0);
    expect(proj.config.compactAfterRatio).toBe(65);
    expect(proj.config.compactAfterBy).toBe("percent");
    expect(proj.consumedToDelete).toContain("compactAfterTokens");
  });

  it("reports every skipped value in a step, not just the first", () => {
    const proj = projectConfig({
      compactAfterTokens: -1,
      compactAfterRatio: 101,
      compactReserveTokens: -5,
    });
    expect(proj.warnings.map((w) => w.key)).toEqual(
      expect.arrayContaining(["compactAfterTokens", "compactAfterRatio", "compactReserveTokens"]),
    );
  });
});

// ── Per-step: dropper fraction merge ────────────────────────────────────────

describe("dropper-fraction-merge", () => {
  it("keeps the pressure threshold and drops fullness", () => {
    const c = migrated({ dropperPressureThreshold: 0.7, dropperPoolFullnessThreshold: 0.1 });
    expect(c.dropperPressureThreshold).toBe(0.7);
    expect("dropperPoolFullnessThreshold" in c).toBe(false);
  });

  it("takes max(pressure, fullness) so a custom floor is not lost", () => {
    const c = migrated({ dropperPressureThreshold: 0.5, dropperPoolFullnessThreshold: 0.8 });
    expect(c.dropperPressureThreshold).toBe(0.8);
  });

  it("raises the pressure threshold to the default when only a higher fullness was set", () => {
    // With no pressure key the old effective trigger was max(0.70, fullness).
    expect(migrated({ dropperPoolFullnessThreshold: 0.9 }).dropperPressureThreshold).toBe(0.9);
  });

  it("leaves a pressure-only file untouched (no fullness key)", () => {
    const c = migrated({ dropperPressureThreshold: 0.42 });
    expect(c.dropperPressureThreshold).toBe(0.42);
    expect("dropperPoolFullnessThreshold" in c).toBe(false);
  });

  it("skips an unrecognized fullness value and reports it", () => {
    const proj = projectConfig({ dropperPoolFullnessThreshold: 2 });
    expect(proj.warnings.map((w) => w.key)).toContain("dropperPoolFullnessThreshold");
    expect(proj.config.dropperPoolFullnessThreshold).toBe(2);
    expect(proj.consumedToDelete).not.toContain("dropperPoolFullnessThreshold");
  });
});

// ── Per-step: input budget merge ────────────────────────────────────────────

describe("input-budget-merge", () => {
  it("fills reflectorInputMaxTokens from the dropper key and drops it", () => {
    const c = migrated({ dropperInputMaxTokens: 5_000 });
    expect(c.reflectorInputMaxTokens).toBe(5_000);
    expect("dropperInputMaxTokens" in c).toBe(false);
  });

  it("keeps an explicit reflector value and still drops the dropper key", () => {
    const c = migrated({ dropperInputMaxTokens: 5_000, reflectorInputMaxTokens: 9_000 });
    expect(c.reflectorInputMaxTokens).toBe(9_000);
    expect("dropperInputMaxTokens" in c).toBe(false);
  });

  it("leaves a reflector-only file untouched", () => {
    const c = migrated({ reflectorInputMaxTokens: 42_000 });
    expect(c.reflectorInputMaxTokens).toBe(42_000);
    expect("dropperInputMaxTokens" in c).toBe(false);
  });

  it("skips an unrecognized dropper budget and reports it", () => {
    const proj = projectConfig({ dropperInputMaxTokens: -1 });
    expect(proj.warnings.map((w) => w.key)).toContain("dropperInputMaxTokens");
    expect(proj.config.dropperInputMaxTokens).toBe(-1);
    expect(proj.consumedToDelete).not.toContain("dropperInputMaxTokens");
  });
});

// ── Per-step: dead knobs ────────────────────────────────────────────────────

describe("dead-knobs", () => {
  it("deletes observationsPoolTargetTokens and observerPreambleMaxTokens", () => {
    const c = migrated({ observationsPoolTargetTokens: 10_000, observerPreambleMaxTokens: 0 });
    expect("observationsPoolTargetTokens" in c).toBe(false);
    expect("observerPreambleMaxTokens" in c).toBe(false);
  });
});

// ── Runner: real fixture ────────────────────────────────────────────────────

describe("runner — real fixture", () => {
  const fixturePath = join(process.cwd(), "example-config-old.json");
  const CONSUMED = [
    "passive",
    "noAutoCompact",
    "overrideDefaultCompaction",
    "observationsPoolTargetTokens",
    "observerPreambleMaxTokens",
    "dropperInputMaxTokens",
  ] as const;

  it("migrates the shipped example-config-old.json", async () => {
    const old = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;
    writeConfig(GLOBAL, old);

    const res = await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(res.persisted).toBe(true);

    const after = readConfig(GLOBAL);
    for (const k of CONSUMED) expect(k in after).toBe(false);
    expect(after.compaction).toBe("off"); // overrideDefaultCompaction:false
    expect("compactAfterTokens" in after).toBe(false); // 81000 residue dropped
    expect(after.reflectorInputMaxTokens).toBe(80_000);
    expect(after.memory).toBe(true);
    expect(after.configVersion).toBe(CONFIG_VERSION);
  });

  it("preserves unknown keys from the fixture", async () => {
    const old = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;
    writeConfig(GLOBAL, old);
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });

    const after = readConfig(GLOBAL);
    expect(after._comment).toBe(old._comment);
    expect(after._notes).toEqual(old._notes);
    expect(after.model).toEqual(old.model);
  });
});

describe("runner — v2 pre-reorg fixture", () => {
  const fixturePath = join(process.cwd(), "tests", "fixtures", "example-config-v2.json");
  const CONSUMED = [
    "compactionEngine",
    "observationsPoolTargetTokens",
    "observerPreambleMaxTokens",
    "dropperInputMaxTokens",
    "dropperPoolFullnessThreshold",
  ] as const;

  it("migrates every fold from the v2 surface in one pass", async () => {
    writeConfig(GLOBAL, JSON.parse(readFileSync(fixturePath, "utf-8")));
    const res = await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(res.persisted).toBe(true);

    const after = readConfig(GLOBAL);
    for (const k of CONSUMED) expect(k in after).toBe(false);
    expect(after.compaction).toBe("automatic"); // compactionEngine:blackhole folded
    expect(after.compactAfterBy).toBe("percent"); // 81000 residue dropped, ratio wins
    expect(after.compactAfterRatio).toBe(65); // fraction converted
    expect("compactAfterTokens" in after).toBe(false); // 81000 residue
    expect(after.dropperPressureThreshold).toBe(0.6); // max(0.4, 0.6)
    expect(after.reflectorInputMaxTokens).toBe(70_000); // dropper budget merged
    expect(after.configVersion).toBe(CONFIG_VERSION);
    expect(after.unknownHandKey).toEqual({ keep: "me" });
  });

  it("the in-memory loader agrees with the on-disk rewrite", async () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;
    const inMemory = migrated(raw);
    writeConfig(GLOBAL, raw);
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    const onDisk = readConfig(GLOBAL);
    // configVersion is the only key the on-disk path adds.
    expect({ ...onDisk, configVersion: undefined }).toEqual({
      ...inMemory,
      configVersion: undefined,
    });
  });
});

// ── Runner: guarantees ──────────────────────────────────────────────────────

describe("runner — guarantees", () => {
  it("preserves unknown and unrelated keys and adds only owned keys", async () => {
    const before = {
      compaction: "auto",
      compactionEngine: "pi-default",
      observeAfterTokens: 15_000,
      memory: true,
      "x-custom": { nested: [1, 2] },
    };
    writeConfig(GLOBAL, before);
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });

    const after = readConfig(GLOBAL);
    expect(after.observeAfterTokens).toBe(15_000);
    expect(after.memory).toBe(true);
    expect(after["x-custom"]).toEqual({ nested: [1, 2] });
    expect(after.compaction).toBe("off");
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.sort()).toEqual(["configVersion"]);
  });

  it("does not write when no owned legacy key is present (gate)", async () => {
    writeConfig(GLOBAL, { compaction: "automatic", observeAfterTokens: 15_000 });
    const writes: number[] = [];
    const res = await migrateConfigFile(GLOBAL, {
      write: async () => {
        writes.push(1);
      },
      warn: () => {},
    });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("skips an unrecognized value without writing", async () => {
    writeConfig(GLOBAL, { compactionEngine: "hybrid" });
    const writes: number[] = [];
    const res = await migrateConfigFile(GLOBAL, {
      write: async () => {
        writes.push(1);
      },
      warn: () => {},
    });
    expect(res.warnings.map((w) => w.key)).toContain("compactionEngine");
    expect(writes).toHaveLength(0);
  });

  it("skips one bad value while still migrating the rest of the file", async () => {
    writeConfig(GLOBAL, { compactionEngine: "hybrid", dropperPoolFullnessThreshold: 0.6 });
    const res = await migrateConfigFile(GLOBAL, { warn: () => {} });
    expect(res.warnings.map((w) => w.key)).toContain("compactionEngine");
    const written = JSON.parse(readFileSync(GLOBAL, "utf-8")) as Record<string, unknown>;
    expect(written.dropperPressureThreshold).toBe(0.7);
    expect("dropperPoolFullnessThreshold" in written).toBe(false);
    // A partial migration is not stamped, so it retries next load.
    expect("configVersion" in written).toBe(false);
  });

  it("is gated by configVersion only when no legacy key is left", async () => {
    // Fully migrated: stamped and clean -> never rewritten.
    writeConfig(GLOBAL, {
      configVersion: 1,
      compaction: "off",
      memory: true,
      compactAfterBy: "preset",
    });
    const writes: number[] = [];
    let res = await migrateConfigFile(GLOBAL, {
      write: async () => {
        writes.push(1);
      },
      warn: () => {},
    });
    expect(res.gated).toBe(true);
    expect(writes).toHaveLength(0);

    // Crash window: stamped but the legacy key was never deleted -> finish it.
    writeConfig(GLOBAL, {
      configVersion: 1,
      compactionEngine: "pi-default",
      compaction: "off",
      memory: true,
    });
    res = await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(res.gated).toBe(false);
    expect(res.persisted).toBe(true);
    const written = readConfig(GLOBAL);
    expect("compactionEngine" in written).toBe(false);
    expect(written.configVersion).toBe(1);
  });

  it("bails before any write when the backup cannot be verified", async () => {
    const original = { compactionEngine: "pi-default", memory: true };
    writeConfig(GLOBAL, original);
    const writes: number[] = [];
    const res = await migrateConfigFile(GLOBAL, {
      backup: async () => {
        throw new Error("EACCES");
      },
      write: async () => {
        writes.push(1);
      },
      warn: () => {},
    });
    expect(res.persisted).toBe(false);
    expect(res.error).toBe("backup failed");
    expect(writes).toHaveLength(0);
    expect(readConfig(GLOBAL)).toEqual(original);
  });

  it("notifies (not just warns) when a value is skipped", async () => {
    writeConfig(GLOBAL, { compactionEngine: "hybrid" });
    const notes: string[] = [];
    await migrateConfigFile(GLOBAL, {
      write: async () => {},
      warn: () => {},
      notify: (m) => notes.push(m),
    });
    expect(notes.join(" ")).toContain("compactionEngine");
  });

  it("never clobbers an existing backup (write-once)", async () => {
    writeConfig(GLOBAL, { compactionEngine: "pi-default" });
    writeText(`${GLOBAL}.bak`, '{"pristine":true}\n');
    await migrateConfigFile(GLOBAL, { warn: () => {} });
    expect(readFileSync(`${GLOBAL}.bak`, "utf-8")).toBe('{"pristine":true}\n');
  });

  it("writes new keys before removing old ones, verifying in between (two-phase)", async () => {
    let disk = `${JSON.stringify({ compaction: "auto", compactionEngine: "pi-default", x: 1 }, null, 2)}\n`;
    writeText(GLOBAL, disk);
    const events: Array<{ op: "read" | "write"; config?: Record<string, unknown> }> = [];

    await migrateConfigFile(GLOBAL, {
      backup: async () => {},
      warn: () => {},
      write: async (_p, text) => {
        events.push({ op: "write", config: JSON.parse(text) as Record<string, unknown> });
        disk = text;
      },
      readText: async () => {
        events.push({ op: "read" });
        return disk;
      },
    });

    const writeIdx = events.reduce<number[]>((acc, e, i) => {
      if (e.op === "write") acc.push(i);
      return acc;
    }, []);
    expect(writeIdx).toHaveLength(2);
    // Phase 1 keeps the old engine key; phase 2 removes it.
    expect(events[writeIdx[0]].config?.compactionEngine).toBe("pi-default");
    expect(events[writeIdx[1]].config?.compactionEngine).toBeUndefined();
    // A verification read happens between the two writes.
    const verifyRead = events.findIndex((e, i) => e.op === "read" && i > writeIdx[0]);
    expect(verifyRead).toBeGreaterThan(writeIdx[0]);
    expect(verifyRead).toBeLessThan(writeIdx[1]);
  });

  it("keeps old keys when phase-1 verification fails (phase-2 safety)", async () => {
    writeText(
      GLOBAL,
      `${JSON.stringify({ compaction: "auto", compactionEngine: "pi-default" }, null, 2)}\n`,
    );
    const res = await migrateConfigFile(GLOBAL, {
      backup: async () => {},
      warn: () => {},
      // Simulate a write that silently drops the produced `compaction` key.
      write: async (p, text) => {
        const obj = JSON.parse(text) as Record<string, unknown>;
        if ("compactionEngine" in obj) delete obj.compaction;
        writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
      },
    });
    expect(res.error).toContain("verification");
    expect(readConfig(GLOBAL).compactionEngine).toBe("pi-default");
  });

  it("takes the remove-only path when the new keys already exist", async () => {
    writeConfig(GLOBAL, { compaction: "automatic", compactionEngine: "blackhole", x: 1 });
    const writes: string[] = [];
    await migrateConfigFile(GLOBAL, {
      backup: async () => {},
      warn: () => {},
      write: async (p, text) => {
        writes.push(text);
        writeFileSync(p, text);
      },
    });
    expect(writes).toHaveLength(1); // one write, no projection phase
    const after = readConfig(GLOBAL);
    expect("compactionEngine" in after).toBe(false);
    expect(after.compaction).toBe("automatic");
    expect(after.x).toBe(1);
  });

  it("is idempotent — the second run is a no-op with identical bytes", async () => {
    writeConfig(GLOBAL, {
      compaction: "auto",
      compactionEngine: "pi-default",
      compactAfterRatio: 0.65,
    });
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    const first = readFileSync(GLOBAL, "utf-8");
    const res = await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(res.changed).toBe(false);
    expect(readFileSync(GLOBAL, "utf-8")).toBe(first);
  });

  it("leaves the original byte-identical when the write throws (atomicity)", async () => {
    const original = `${JSON.stringify({ compaction: "auto", compactionEngine: "pi-default" }, null, 2)}\n`;
    writeText(GLOBAL, original);
    const res = await migrateConfigFile(GLOBAL, {
      backup: async () => {},
      warn: () => {},
      write: async () => {
        throw new Error("boom");
      },
    });
    expect(res.persisted).toBe(false);
    expect(readFileSync(GLOBAL, "utf-8")).toBe(original);
  });

  it("atomicWrite replaces content and leaves no temp file behind", async () => {
    writeText(GLOBAL, "old\n");
    await atomicWrite(GLOBAL, "new\n");
    expect(readFileSync(GLOBAL, "utf-8")).toBe("new\n");
    const leftovers = readdirSync(dirname(GLOBAL)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  it("handles read-only filesystems by warning and returning the in-memory projection", async () => {
    writeConfig(GLOBAL, { compaction: "auto", compactionEngine: "pi-default" });
    const warnings: string[] = [];
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const res = await migrateConfigFile(GLOBAL, {
      backup: async () => {},
      warn: (m) => warnings.push(m),
      write: async () => {
        throw err;
      },
    });
    expect(res.persisted).toBe(false);
    expect(res.config?.compaction).toBe("off");
    expect(res.config?.compactionEngine).toBe("pi-default"); // old key retained
    expect(warnings.join(" ")).toContain("read-only");
  });

  it("skips a corrupt JSON file without writing", async () => {
    mkdirSync(dirname(GLOBAL), { recursive: true });
    writeFileSync(GLOBAL, "{ not valid json");
    const writes: number[] = [];
    const res = await migrateConfigFile(GLOBAL, {
      write: async () => {
        writes.push(1);
      },
      warn: () => {},
    });
    expect(res.changed).toBe(false);
    expect(writes).toHaveLength(0);
    expect(readFileSync(GLOBAL, "utf-8")).toBe("{ not valid json");
  });

  it("migrates global and project files independently", async () => {
    writeConfig(GLOBAL, { compaction: "auto", compactionEngine: "pi-default" });
    writeConfig(PROJECT, { compactAfterRatio: 0.65 });

    const results = await migrateConfigFiles(testDir, { backup: async () => {}, warn: () => {} });
    expect(results).toHaveLength(2);
    expect(readConfig(GLOBAL).compaction).toBe("off");
    expect(readConfig(PROJECT).compactAfterBy).toBe("percent");
    expect(readConfig(PROJECT).compactAfterRatio).toBe(65);
  });

  it("stamps configVersion once and preserves an existing stamp", async () => {
    writeConfig(GLOBAL, { compaction: "auto", compactionEngine: "pi-default" });
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(readConfig(GLOBAL).configVersion).toBe(CONFIG_VERSION);

    writeConfig(GLOBAL, { configVersion: 7, compaction: "auto", compactionEngine: "pi-default" });
    await migrateConfigFile(GLOBAL, { backup: async () => {}, warn: () => {} });
    expect(readConfig(GLOBAL).configVersion).toBe(7);
  });
});
