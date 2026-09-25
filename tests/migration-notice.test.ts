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

  test("notifies once with the migration copy after a migration ran", () => {
    const calls: Array<{ message: string; level: string }> = [];
    const notified = maybeNotifyConfigMigration(uiCtx, true, {
      ...deps,
      notify: (message, level) => calls.push({ message, level }),
    });

    expect(notified).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("info");
    // T4: assert the unique actionable tokens, not a generic substring.
    expect(calls[0]!.message).toContain("/blackhole settings");
    expect(calls[0]!.message).toContain("/blackhole changelog");
    expect(calls[0]!.message).toContain("MIGRATION-GUIDE.md");
  });

  test("silent when no migration ran", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, false, {
        ...deps,
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("second call in the same process is silent (once-per-process guard)", () => {
    const calls: Array<{ message: string; level: string }> = [];
    const recorder = {
      ...deps,
      notify: (message: string, level: "info") => calls.push({ message, level }),
    };
    expect(maybeNotifyConfigMigration(uiCtx, true, recorder)).toBe(true);
    expect(maybeNotifyConfigMigration(uiCtx, true, recorder)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("silent when the running version differs from the notice version", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, true, {
        version: "0.0.1",
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("falls back to the running package version when no override is given", () => {
    const running = getPackageVersion();
    const shouldNotify = running === MIGRATION_NOTICE_VERSION;
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyConfigMigration(uiCtx, true, {
        version: undefined,
        notify: (message, level) => calls.push({ message, level }),
      }),
    ).toBe(shouldNotify);
    expect(calls).toHaveLength(shouldNotify ? 1 : 0);
  });

  test("silent without UI", () => {
    const calls: Array<{ message: string; level: string }> = [];
    expect(
      maybeNotifyConfigMigration(
        {
          hasUI: false,
          ui: { notify: (m: string, l?: string) => calls.push({ message: m, level: l ?? "" }) },
        },
        true,
        { ...deps, notify: (message, level) => calls.push({ message, level }) },
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a throwing ui.notify is swallowed and the guard is still set", () => {
    expect(() =>
      maybeNotifyConfigMigration(uiCtx, true, {
        ...deps,
        notify: () => {
          throw new Error("stale extension context");
        },
      }),
    ).not.toThrow();
    // Guard set despite the throw — no retry nag in the same process.
    expect(
      maybeNotifyConfigMigration(uiCtx, true, {
        ...deps,
        notify: () => {
          throw new Error("should not be reached");
        },
      }),
    ).toBe(false);
  });
});
