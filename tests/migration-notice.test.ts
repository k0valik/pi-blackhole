import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MIGRATION_NOTICE_VERSION,
  maybeNotifyConfigMigration,
  resetMigrationNoticeForTests,
} from "../src/changelog/migration-notice.js";
import { getPackageVersion } from "../src/changelog/changelog.js";

describe("maybeNotifyConfigMigration", () => {
  beforeEach(() => {
    resetMigrationNoticeForTests();
  });

  afterEach(() => {
    resetMigrationNoticeForTests();
  });

  const deps = { version: MIGRATION_NOTICE_VERSION };
  const uiCtx = { hasUI: true, ui: { notify: (_m: string, _l?: string) => {} } };
  type Call = { message: string; level: string };

  function recorder(calls: Call[]) {
    return {
      ...deps,
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

  test("silent when the running version differs from the notice version", () => {
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        version: "0.0.1",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("falls back to the running package version when no override is given", () => {
    const running = getPackageVersion();
    const shouldNotify = running === MIGRATION_NOTICE_VERSION;
    const calls: Call[] = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, "none", {
        version: undefined,
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(shouldNotify);
    expect(calls).toHaveLength(shouldNotify ? 2 : 0);
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
        ...deps,
        notify: () => {
          throw new Error("stale extension context");
        },
      }),
    ).not.toThrow();
    // Guard set despite the throw — no retry nag in the same process.
    expect(
      maybeNotifyConfigMigration(uiCtx, "migrated", {
        ...deps,
        notify: () => {
          throw new Error("should not be reached");
        },
      }),
    ).toBe(false);
  });
});
