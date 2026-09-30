import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MIGRATION_NOTICE_VERSION,
  maybeNotifyConfigMigration,
  resetMigrationNoticeForTests,
} from "../src/changelog/migration-notice.js";
import { getPackageVersion } from "../src/changelog/changelog.js";

describe("maybeNotifyConfigMigration", () => {
  let stampDir: string;
  let stampPath: string;

  beforeEach(() => {
    resetMigrationNoticeForTests();
    // Isolated stamp: never touch the real ~/.pi/agent/pi-blackhole one.
    stampDir = mkdtempSync(join(tmpdir(), "pi-blackhole-notice-"));
    stampPath = join(stampDir, "stamp.json");
  });

  afterEach(() => {
    resetMigrationNoticeForTests();
    rmSync(stampDir, { recursive: true, force: true });
  });

  const uiCtx = { hasUI: true, ui: { notify: (_m: string, _l?: string) => {} } };
  type Call = { message: string; level: string };

  function baseDeps() {
    return { version: MIGRATION_NOTICE_VERSION, stampPath };
  }

  function recorder(calls: Call[]) {
    return {
      ...baseDeps(),
      notify: (message: string, level: string) => calls.push({ message, level }),
    };
  }

  test("emits the upgrade notice + a separate migrated outcome after a migration", () => {
    const calls: Call[] = [];
    const notified = maybeNotifyConfigMigration(uiCtx, "migrated", recorder(calls));

    expect(notified).toBe(true);
    expect(calls).toHaveLength(2);
    // T4: assert the unique actionable tokens, not a generic substring.
    expect(calls[0]!.level).toBe("info");
    expect(calls[0]!.message).toContain("/blackhole settings");
    expect(calls[0]!.message).toContain("/blackhole changelog");
    expect(calls[0]!.message).toContain("MIGRATION-GUIDE.md");
    expect(calls[1]!.level).toBe("info");
    expect(calls[1]!.message).toContain("migrated");
  });

  test("fires even when no migration ran, with a 'no migration' outcome", () => {
    const calls: Call[] = [];
    expect(maybeNotifyConfigMigration(uiCtx, "none", recorder(calls))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.message).toContain("needed no migration");
  });

  test("reports a blocked (read-only) migration as its own outcome", () => {
    const calls: Call[] = [];
    expect(maybeNotifyConfigMigration(uiCtx, "blocked", recorder(calls))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.message).toContain("could not be written");
  });

  test("second call in the same process is silent (once-per-process guard)", () => {
    const calls: Call[] = [];
    const rec = recorder(calls);
    expect(maybeNotifyConfigMigration(uiCtx, "migrated", rec)).toBe(true);
    expect(maybeNotifyConfigMigration(uiCtx, "migrated", rec)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("records the stamp file so the next process stays silent", () => {
    const calls: Call[] = [];
    expect(maybeNotifyConfigMigration(uiCtx, "migrated", recorder(calls))).toBe(true);
    expect(maybeNotifyConfigMigration(uiCtx, "migrated", recorder(calls))).toBe(false);
    expect(calls).toHaveLength(2);
    // T3: the stamp is written on show, so a fresh process has a real record.
    expect(existsSync(stampPath)).toBe(true);
    expect(JSON.parse(readFileSync(stampPath, "utf-8")).shownAt).toMatch(/^\d{4}-/);
  });

  test("silent when the stamp is already present (once per install)", () => {
    writeFileSync(stampPath, JSON.stringify({ shownAt: "2026-01-01T00:00:00.000Z" }));
    const calls: Call[] = [];
    expect(maybeNotifyConfigMigration(uiCtx, "migrated", recorder(calls))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("silent when the running version differs from the notice version", () => {
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...baseDeps(),
        version: "0.0.1",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("fires when the running version is past the notice version", () => {
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...baseDeps(),
        version: "0.6.1",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("ignores a prerelease suffix when comparing versions", () => {
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...baseDeps(),
        version: "0.7.0-rc.1",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("falls back to the running package version when no override is given", () => {
    // Delegation check: implicit and explicit versions must take the same gate.
    const running = getPackageVersion();
    const explicitCalls: Call[] = [];
    const explicit = maybeNotifyConfigMigration(uiCtx, "none", {
      version: running,
      stampPath,
      notify: (message, level) => explicitCalls.push({ message, level }),
    });

    resetMigrationNoticeForTests();
    const fallbackCalls: Call[] = [];
    const fallback = maybeNotifyConfigMigration(uiCtx, "none", {
      version: undefined,
      stampPath: join(stampDir, "stamp2.json"),
      notify: (message, level) => fallbackCalls.push({ message, level }),
    });

    expect(fallback).toBe(explicit);
    expect(fallbackCalls).toHaveLength(explicitCalls.length);
  });

  test("silent without UI", () => {
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(
        {
          hasUI: false,
          ui: { notify: (m: string, l?: string) => calls.push({ message: m, level: l ?? "" }) },
        },
        "migrated",
        recorder(calls),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a throwing ui.notify is swallowed and the guard is still set", () => {
    expect(() =>
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...baseDeps(),
        notify: () => {
          throw new Error("stale extension context");
        },
      }),
    ).not.toThrow();
    // Guard set despite the throw — no retry nag in the same process.
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...baseDeps(),
        notify: () => {
          throw new Error("should not be reached");
        },
      }),
    ).toBe(false);
  });
});
