import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/before-compact.js", () => ({
  PI_VCC_COMPACT_INSTRUCTION: "__pi_vcc__",
  notifyMigrationReminder: vi.fn(),
  formatCompactionStats: vi.fn(),
}));
vi.mock("../src/om/pending.js", () => ({
  readPendingState: vi.fn(),
  clearPendingState: vi.fn(),
  hasPendingData: () => false,
}));

let imports: string[];
let openSettings: ReturnType<typeof vi.fn>;
let openChangelog: ReturnType<typeof vi.fn>;
let cleanup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  imports = [];
  openSettings = vi.fn(async () => {});
  openChangelog = vi.fn(async () => {});
  cleanup = vi.fn(async () => {});
  vi.doMock("../src/pi-base/blackhole-settings.js", () => {
    imports.push("settings");
    return { openBlackholeSettings: openSettings };
  });
  vi.doMock("../src/changelog/changelog.js", () => {
    imports.push("changelog");
    return { openChangelogView: openChangelog };
  });
  vi.doMock("../src/commands/cleanup.js", () => {
    imports.push("cleanup");
    return { handleCleanup: cleanup };
  });
  vi.doMock("../src/project-recall/session-dir.js", () => {
    imports.push("session-dir");
    return { findGitRoot: vi.fn(async () => ({ root: "/project" })) };
  });
  vi.doMock("../src/project-recall/corpus.js", () => {
    imports.push("corpus");
    return {
      buildProjectMemoryCorpusAsync: vi.fn(async () => ({
        projectRoot: "/project",
        sessionsConsidered: 0,
        observations: [],
        reflections: [],
        droppedIds: new Set(),
      })),
    };
  });
  vi.doMock("../src/project-recall/format-export.js", () => {
    imports.push("export-formatter");
    return { buildExportMarkdownAsync: vi.fn() };
  });
});

async function fixture() {
  const { registerPiVccCommand } = await import("../src/commands/pi-vcc.js");
  let command: any;
  const ctx = {
    sessionManager: { getSessionId: () => "test" },
    compact: vi.fn(),
    ui: { notify: vi.fn() },
  };
  registerPiVccCommand(
    {
      registerCommand: (_name: string, def: any) => {
        command = def;
      },
    } as any,
    { config: {} } as any,
  );
  return { command, ctx };
}

describe("lazy command imports", () => {
  it("does not load optional command modules for registration, completion or manual compaction", async () => {
    const { command, ctx } = await fixture();
    expect(imports).toEqual([]);
    expect(command.getArgumentCompletions("set")).toHaveLength(1);
    await command.handler("", ctx);
    await command.handler("settings extra", ctx);
    expect(ctx.compact).toHaveBeenCalledOnce();
    expect(imports).toEqual([]);
  });

  it.each(["settings", "configure", "changelog", "cleanup"])(
    "loads only the requested %s implementation",
    async (name) => {
      const { command, ctx } = await fixture();
      await command.handler(name, ctx);
      const expected = name === "configure" ? "settings" : name;
      expect(imports).toEqual([expected]);
      const called =
        expected === "settings" ? openSettings : expected === "changelog" ? openChangelog : cleanup;
      expect(called).toHaveBeenCalledWith(ctx);
      expect(ctx.compact).not.toHaveBeenCalled();
    },
  );

  it("does not load the export pipeline before validation or its formatter for empty data", async () => {
    const { registerBlackholeExportCommand } = await import("../src/commands/blackhole-export.js");
    let command: any;
    registerBlackholeExportCommand({
      registerCommand: (_name: string, def: any) => {
        command = def;
      },
    } as any);
    const ctx = {
      cwd: "/project",
      ui: { notify: vi.fn() },
      sessionManager: { getSessionFile: () => undefined },
    };
    expect(imports).toEqual([]);
    await command.handler("out:invalid.txt", ctx);
    expect(imports).toEqual([]);
    await command.handler("", ctx);
    expect(imports).toEqual(["session-dir", "corpus"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No observational memory"),
      "warning",
    );
  });
});
