import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MIGRATION_NOTICE_VERSION,
  isThresholdMigrationCandidate,
  maybeNotifyThresholdMigration,
  resetMigrationNoticeForTests,
} from "../src/changelog/migration-notice.js";
import { getPackageVersion } from "../src/changelog/changelog.js";
import { __setTestConfigDir, loadUnifiedConfig } from "../src/core/unified-config.js";

import type { MigrationNoticeConfig } from "../src/changelog/migration-notice.js";

function pinnedConfig(): MigrationNoticeConfig {
  return {
    compaction: "auto",
    compactionEngine: "blackhole",
    compactAfterTokens: 120_000,
  };
}

describe("isThresholdMigrationCandidate", () => {
  test("true for an auto/blackhole config with a flat compactAfterTokens pin", () => {
    expect(isThresholdMigrationCandidate(pinnedConfig())).toBe(true);
  });

  test("false when no compactAfterTokens is set on auto (already on the curve)", () => {
    expect(
      isThresholdMigrationCandidate({ compaction: "auto", compactionEngine: "blackhole" }),
    ).toBe(false);
  });

  test("true on manual mode even without a pin — opted out, nudge to reconsider", () => {
    expect(
      isThresholdMigrationCandidate({ compaction: "manual", compactionEngine: "blackhole" }),
    ).toBe(true);
    expect(
      isThresholdMigrationCandidate({
        compaction: "manual",
        compactionEngine: "blackhole",
        compactAfterTokens: 120_000,
      }),
    ).toBe(true);
  });

  test("true on off mode even without a pin — opted out, nudge to reconsider", () => {
    expect(
      isThresholdMigrationCandidate({ compaction: "off", compactionEngine: "blackhole" }),
    ).toBe(true);
  });

  test.each([
    ["compactAfterRatio", { compactAfterRatio: 0.65 }],
    ["compactReserveTokens", { compactReserveTokens: 20_000 }],
    ["compactAfterPreset (non-default)", { compactAfterPreset: "aggressive" }],
  ])("false when a derived knob is engaged: %s", (_name, knob) => {
    expect(isThresholdMigrationCandidate({ ...pinnedConfig(), ...knob })).toBe(false);
  });

  test("false when custom preset definitions are configured", () => {
    expect(
      isThresholdMigrationCandidate({
        ...pinnedConfig(),
        compactAfterPresets: { tiny: [{ window: 32_768, ratio: 0.9 }] },
      }),
    ).toBe(false);
  });

  test("false for the default preset name (no engagement implied)", () => {
    expect(
      isThresholdMigrationCandidate({ ...pinnedConfig(), compactAfterPreset: "default" }),
    ).toBe(true);
  });

  test.each(["auto", "manual", "off"] as const)(
    "false when non-derived knob engaged on mode %s (already adopted)",
    (mode) => {
      expect(
        isThresholdMigrationCandidate({
          ...pinnedConfig(),
          compaction: mode,
          compactAfterRatio: 0.65,
        }),
      ).toBe(false);
    },
  );

  test("false when compactionEngine is pi-default", () => {
    expect(
      isThresholdMigrationCandidate({ ...pinnedConfig(), compactionEngine: "pi-default" }),
    ).toBe(false);
  });
});

describe("maybeNotifyThresholdMigration", () => {
  let testDir: string;

  beforeEach(() => {
    resetMigrationNoticeForTests();
    testDir = mkdtempSync(join(tmpdir(), "pi-blackhole-migration-notice-"));
    __setTestConfigDir(testDir);
  });

  afterEach(() => {
    __setTestConfigDir(undefined);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.PI_BLACKHOLE_PASSIVE;
  });

  const deps = { version: MIGRATION_NOTICE_VERSION };
  const uiCtx = { hasUI: true, ui: { notify: (_m: string, _l?: string) => {} } };

  test("notifies once with the migration copy for a pinned config (red-first wiring check)", () => {
    const calls: Array<{ message: string; level: string }> = [];
    const notified = maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), {
      ...deps,
      notify: (message, level) => calls.push({ message, level }),
    });

    expect(notified).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("info");
    // T4: assert the unique actionable tokens, not a generic substring.
    expect(calls[0]!.message).toContain("/blackhole settings");
    expect(calls[0]!.message).toContain("/blackhole changelog");
  });

  test("second call in the same process is silent (once-per-process guard)", () => {
    const calls: Array<{ message: string; level: string }> = [];
    const depsWithRecorder = {
      ...deps,
      notify: (message: string, level: "info") => calls.push({ message, level }),
    };
    expect(maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), depsWithRecorder)).toBe(true);
    expect(maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), depsWithRecorder)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("silent when running version differs from the notice version", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), {
        version: "0.5.3",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("falls back to the running package version when no override is given", () => {
    // Version-independent: the expectation is derived from the ambient
    // package version instead of assuming it differs (it equals the notice
    // version exactly once the 0.5.2 release is bumped).
    const running = getPackageVersion();
    const shouldNotify = running === MIGRATION_NOTICE_VERSION;
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), {
        version: undefined,
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(shouldNotify);
    expect(calls).toHaveLength(shouldNotify ? 1 : 0);
  });

  test("silent without UI", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyThresholdMigration(
        {
          hasUI: false,
          ui: { notify: (m: string, l?: string) => calls.push({ message: m, level: l ?? "" }) },
        },
        pinnedConfig(),
        { ...deps, notify: (message, level) => calls.push({ message, level }) },
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("silent when the config is not a migration candidate", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyThresholdMigration(
        uiCtx,
        { compaction: "auto", compactionEngine: "blackhole" },
        { ...deps, notify: (message, level) => calls.push({ message, level }) },
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a throwing ui.notify is swallowed and the guard is still set", () => {
    expect(() =>
      maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), {
        ...deps,
        notify: () => {
          throw new Error("stale extension context");
        },
      }),
    ).not.toThrow();
    // Guard set despite the throw — no retry nag in the same process.
    expect(
      maybeNotifyThresholdMigration(uiCtx, pinnedConfig(), {
        ...deps,
        notify: () => {
          throw new Error("should not be reached");
        },
      }),
    ).toBe(false);
  });

  test("scaffolded legacy 81000 never notifies — the loader strips it as residue", () => {
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      join(testDir, "pi-blackhole", "pi-blackhole-config.json"),
      JSON.stringify({ compaction: "auto", compactAfterTokens: 81000 }, null, 2),
    );
    const loaded = loadUnifiedConfig(testDir);
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyThresholdMigration(uiCtx, loaded, {
        ...deps,
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an env-pinned compactAfterTokens does notify — env values are never residue", () => {
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      join(testDir, "pi-blackhole", "pi-blackhole-config.json"),
      JSON.stringify({ compaction: "auto", compactAfterTokens: 81000 }, null, 2),
    );
    process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS = "81000";
    try {
      const loaded = loadUnifiedConfig(testDir);
      const calls: Array<{ message: string; level: string }> = [];
      expect(
        maybeNotifyThresholdMigration(uiCtx, loaded, {
          ...deps,
          notify: (message, level) => calls.push({ message, level }),
        }),
      ).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      delete process.env.PI_BLACKHOLE_COMPACT_AFTER_TOKENS;
    }
  });

  test("PI_BLACKHOLE_PASSIVE=true disables compaction via the loader → silent", () => {
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      join(testDir, "pi-blackhole", "pi-blackhole-config.json"),
      JSON.stringify({ compaction: "auto", compactAfterTokens: 120_000 }, null, 2),
    );
    process.env.PI_BLACKHOLE_PASSIVE = "true";
    try {
      const loaded = loadUnifiedConfig(testDir);
      const calls: Array<{ message: string; level: string }> = [];
      expect(
        maybeNotifyThresholdMigration(uiCtx, loaded, {
          ...deps,
          notify: (message, level) => calls.push({ message, level }),
        }),
      ).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.PI_BLACKHOLE_PASSIVE;
    }
  });
});
