/**
 * Smoke tests for ConfigFlow (settings/config-flow.ts).
 *
 * Harness: fake ExtensionContext with a mock ctx.ui.custom that captures
 * the factory. Tests invoke the factory manually with fake tui/theme to
 * get the component, drive it via handleInput, then await the flow.
 *
 * CRITICAL: handleInput must be called BEFORE the await, because the
 * selector's done() → factory done() → resolve happens synchronously
 * during handleInput.
 *
 * createConfirm is mocked so tests can drive the confirm dialog.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import type {
  ExtensionContext,
  ExtensionUIContext,
  FileEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { ConfigManager, type ConfigManagerOptions } from "../config-manager.ts";
import { setSessionConfig, clearAllSessionConfigs } from "../config.ts";

// ── Mock createConfirm to capture confirm instances ────────────────────

const mockCreateConfirm = vi.hoisted(() => {
  const confirmRefs: Array<{
    resolve: (confirmed: boolean) => void;
    message: string[];
  }> = [];
  return {
    confirmRefs,
    create: vi.fn(
      (
        opts: { message: string[]; confirmLabel?: string; danger?: boolean },
        done: (c: boolean) => void,
      ) =>
        ({
          render: (_w: number) => [`[confirm: ${opts.message.join(" ")}]`],
          handleInput: (_d: string) => {},
        }) as Component,
    ),
    reset() {
      confirmRefs.length = 0;
    },
  };
});

vi.mock("../settings/confirm.ts", () => ({
  createConfirm: (...args: Parameters<typeof mockCreateConfirm.create>) => {
    const [opts, done] = args;
    mockCreateConfirm.confirmRefs.push({
      resolve: done as (c: boolean) => void,
      message: opts.message,
    });
    return mockCreateConfirm.create(opts, done);
  },
}));

// ── Types ──────────────────────────────────────────────────────────────

type FakeContext = ExtensionContext & {
  ui: ExtensionUIContext & {
    custom: Mock;
    done: Mock;
  };
};

interface TestConfig {
  enabled: boolean;
  threshold: number;
}

const DEFAULTS: TestConfig = { enabled: true, threshold: 5 };

// ── Stubs ──────────────────────────────────────────────────────────────

function fakeTui(): TUI {
  return { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() } as unknown as TUI;
}

function fakeTheme(): Theme {
  const passthrough = (_color: string, text: string): string => text;
  return {
    fg: passthrough,
    bg: passthrough,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

function fakeCtx(notify: ReturnType<typeof vi.fn> = vi.fn()): FakeContext {
  return {
    ui: {
      tui: fakeTui(),
      theme: fakeTheme(),
      notify,
      custom: vi.fn(),
      done: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [],
    },
  } as unknown as FakeContext;
}

// ── Helpers ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/config-flow-test-");
  mockCreateConfirm.reset();
  clearAllSessionConfigs();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createManager(opts?: Partial<ConfigManagerOptions<TestConfig>>) {
  return new ConfigManager<TestConfig>({
    id: "flow-test",
    label: "FlowTest",
    filename: "flow-test-config.json",
    defaults: DEFAULTS,
    fields: (cfg: TestConfig) => [
      { key: "enabled", type: "boolean", label: "Enabled", value: cfg.enabled },
      {
        key: "threshold",
        type: "number",
        label: "Threshold",
        value: cfg.threshold,
        min: 1,
        max: 10,
      },
    ],
    ...opts,
  });
}

function writeGlobal(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "flow-test-config.json"), JSON.stringify(data));
}

function writeProject(data: Record<string, unknown>) {
  const d = join(tempDir, ".pi");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "flow-test-config.json"), JSON.stringify(data));
}

/**
 * Drive the selector to choose the first edit-mode entry (Global).
 * Display All is now the first entry, so skip it with one down press.
 * Returns after the selector's done() has resolved the outer Promise.
 */
async function selectFirst(ctx: FakeContext): Promise<void> {
  const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
  const factory = customMock.mock.calls[0]?.[0] as (
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    done: (r: unknown) => void,
  ) => Component;

  const sel = factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
    ctx.ui.done(r);
  });
  sel.handleInput?.("\x1b[B"); // down → skip Display All, reach Global
  sel.handleInput?.("\r"); // Enter → select Global
  // done() fires synchronously → Promise resolves immediately
  await ctx.ui.done(vi.fn());
}

/**
 * After selectFirst resolves, retrieve the edit body from the second
 * ctx.ui.custom call (openEditMode).
 */
function getEditBody(ctx: FakeContext, callIndex = 1): Component {
  const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
  const editFactory = customMock.mock.calls[callIndex]?.[0] as (
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    done: (r: unknown) => void,
  ) => Component;
  return editFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
    ctx.ui.done(r);
  });
}

/**
 * After a body action mounts a confirm, retrieve it from the captured refs.
 * Returns the last confirm instance.
 */
function getLastConfirm(): Component {
  const refs = mockCreateConfirm.confirmRefs;
  expect(refs.length).toBeGreaterThan(0);
  const last = refs[refs.length - 1]!;
  return {
    render: (_w: number) => [`[confirm: ${last.message.join(" ")}]`],
    handleInput: (data: string) => {
      if (data === "\r" || data === "\n") {
        last.resolve(true);
      } else if (data === "\x1b") {
        last.resolve(false);
      }
    },
    invalidate: () => {},
  };
}

/**
 * After selecting display-all from the selector, retrieve the display-all
 * body from the next ctx.ui.custom call.
 */
function getDisplayAllBody(ctx: FakeContext): Component {
  const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
  const daFactory = customMock.mock.calls[1]?.[0] as (
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    done: (r: unknown) => void,
  ) => Component;
  return daFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
    ctx.ui.done(r);
  });
}

/**
 * Flush microtasks so async flow handlers (reset/delete/save) complete.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

/**
 * Count available selector entries for a given setup.
 */
function availableCount(
  sessionInitialized: boolean,
  scopes?: { global?: boolean; project?: boolean; session?: boolean },
): number {
  const s = scopes ?? { global: true, project: true, session: true };
  let count = 0;
  if (s.global !== false) count++;
  if (s.project !== false) count++;
  if (s.session !== false && sessionInitialized) count++;
  count++; // display-all always available
  return count;
}

/**
 * Display All is now the first entry (index 0), already selected by default.
 */
function navigateToDisplayAll(
  _sel: Component,
  _sessionInitialized: boolean,
  _scopes?: { global?: boolean; project?: boolean; session?: boolean },
): void {
  // Display All is pre-selected as the first entry — no navigation needed.
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("ConfigFlow smoke tests", () => {
  // ── 1. Selector opens, entries, Esc ─────────────────────────────────

  describe("selector", () => {
    it("opens first with title, subtitle, and scope entries", async () => {
      const notify = vi.fn();
      const ctx = fakeCtx(notify);
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const factory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const out = sel.render(80).join("\n");
      expect(out).toContain("FlowTest");
      expect(out).toContain("Configure settings for FlowTest");
      expect(out).toContain("Configure Global settings");
      expect(out).toContain("Configure Project local settings");
      expect(out).toContain("Configure Session settings");
      expect(out).toContain("Display all settings");

      // Cancel the flow
      sel.handleInput?.("\x1b");
      await promise;
      expect(customMock).toHaveBeenCalledTimes(1); // only selector
    });

    it("Esc cancels the flow (no edit mode opened)", async () => {
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const factory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      sel.handleInput?.("\x1b");

      await promise;
      expect(customMock).toHaveBeenCalledTimes(1);
    });

    it("selector is frame-wrapped with border chars", async () => {
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const factory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const out = sel.render(80).join("\n");
      expect(out).toContain("╭");
      expect(out).toContain("╯");

      sel.handleInput?.("\x1b");
      await promise;
    });
  });

  // ── 2. Selector → global edit mode ─────────────────────────────────

  describe("edit mode", () => {
    it("selector → global: scope-locked title, layer values, actions", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const notify = vi.fn();
      const ctx = fakeCtx(notify);
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Select global
      await selectFirst(ctx);

      const body = getEditBody(ctx);
      const out = body.render(80).join("\n");

      // Scope-locked title
      expect(out).toContain("FlowTest — Global");
      // Layer values shown
      expect(out).toContain("Enabled");
      expect(out).toContain("Threshold");
      // Actions
      expect(out).toContain("Save");
      expect(out).toContain("Discard");
      expect(out).toContain("Reset");
      expect(out).toContain("Delete");

      await promise;
    });

    it("inherited rows show (from default) note", async () => {
      // File only overrides threshold; enabled stays at default
      writeGlobal({ threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);
      const out = body.render(80).join("\n");

      // enabled is inherited from defaults
      expect(out).toContain("(from default)");
      // threshold is from global
      expect(out).toContain("9");

      await promise;
    });

    it("editing an inherited field drops the (from ...) note", async () => {
      writeGlobal({ threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Before edit: inherited field shows note
      let out = body.render(80).join("\n");
      expect(out).toContain("(from default)");

      // Toggle the inherited boolean (enabled)
      body.handleInput?.("\r");

      // After edit: note is gone because the field is dirty locally
      out = body.render(80).join("\n");
      expect(out).not.toContain("(from default)");

      await promise;
    });

    it("after delete, inherited note reappears if value falls back", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Toggle inherited field to make it dirty (note disappears)
      body.handleInput?.("\r");
      let out = body.render(80).join("\n");
      expect(out).not.toContain("(from default)");

      // Delete the global file
      for (let i = 0; i < 4; i++) body.handleInput?.("\t"); // Tab to Delete
      body.handleInput?.("\r");
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");
      await flushMicrotasks();

      // After delete: values fall back to defaults, dirty cleared,
      // inspection refreshed → note reappears
      out = body.render(80).join("\n");
      expect(out).toContain("(from default)");

      await promise;
    });
  });

  // ── 3. Edit mode save ───────────────────────────────────────────────

  describe("save", () => {
    it("save action → yes/no confirm → writes file → onSave called → flow closes", async () => {
      writeGlobal({ enabled: true, threshold: 5 });
      const onSave = vi.fn();
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, onSave, tempDir);

      // Select global
      await selectFirst(ctx);

      const body = getEditBody(ctx);

      // Toggle boolean to create a real diff
      body.handleInput?.("\r");

      // Tab to Save (1st action) and press Enter
      body.handleInput?.("\t");
      body.handleInput?.("\r");

      // Confirm mounted — verify via render output
      const withConfirm = body.render(80).join("\n");
      expect(withConfirm).toContain("Really save to Global");

      // Drive confirm: Enter = Save
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      await promise;

      // File written with changed key
      const saved = JSON.parse(readFileSync(join(tempDir, "flow-test-config.json"), "utf-8"));
      expect(saved).toEqual({ enabled: false, threshold: 5 });
      // onSave called with validated config
      expect(onSave).toHaveBeenCalledWith({ enabled: false, threshold: 5 });
    });

    it("first project save notifies with absolute path", async () => {
      const notify = vi.fn();
      const ctx = fakeCtx(notify);
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Select project (display-all=0, global=1, project=2, session=3)
      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      sel.handleInput?.("\x1b[B"); // down → global
      sel.handleInput?.("\x1b[B"); // down → project
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const body = getEditBody(ctx);
      body.handleInput?.("\t");
      body.handleInput?.("\r");

      // Confirm and complete
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      await promise;

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(`Project config written to ${tempDir}`),
        "info",
      );
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("second project save does not notify again", async () => {
      const notify = vi.fn();
      const ctx = fakeCtx(notify);
      const mgr = createManager();

      // Pre-create project file so first save is not a create
      writeProject({ enabled: false, threshold: 7 });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      sel.handleInput?.("\x1b[B"); // down → global
      sel.handleInput?.("\x1b[B"); // down → project
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const body = getEditBody(ctx);
      body.handleInput?.("\t");
      body.handleInput?.("\r");

      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      await promise;

      expect(notify).not.toHaveBeenCalled();
    });
  });

  // ── 5. Discard ──────────────────────────────────────────────────────

  describe("discard", () => {
    it("dirty Esc → discard confirm → close without writing", async () => {
      writeGlobal({ enabled: true, threshold: 5 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Toggle boolean (makes dirty)
      body.handleInput?.("\r");
      // Esc → triggers onRequestExit → discard confirm
      body.handleInput?.("\x1b");

      // Verify discard confirm is rendered
      const withDiscard = body.render(80).join("\n");
      expect(withDiscard).toContain("Discard changes?");

      // Confirm discard
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      await promise;

      // File unchanged
      const content = JSON.parse(readFileSync(join(tempDir, "flow-test-config.json"), "utf-8"));
      expect(content).toEqual({ enabled: true, threshold: 5 });
    });

    it("discard confirm Cancel → dismisses overlay and stays in edit mode", async () => {
      writeGlobal({ enabled: true, threshold: 5 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Toggle boolean (makes dirty)
      body.handleInput?.("\r");
      // Esc → discard confirm
      body.handleInput?.("\x1b");

      // Cancel the discard confirm (Esc)
      const confirm = getLastConfirm();
      confirm.handleInput?.("\x1b");

      // Flush async cancel handler (dismissOverlay runs in microtask)
      await flushMicrotasks();

      // Overlay dismissed; body render shows just the body
      const afterCancel = body.render(80).join("\n");
      expect(afterCancel).not.toContain("Discard changes?");

      await promise;
    });
  });

  // ── 6. Reset ────────────────────────────────────────────────────────

  describe("reset", () => {
    it("reset confirm → calls resetScope → file removed → stays open", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Tab to Reset (3rd action: Save=0, Discard=1, Reset=2) and activate
      for (let i = 0; i < 3; i++) body.handleInput?.("\t");
      body.handleInput?.("\r");

      // Verify reset confirm rendered
      const withReset = body.render(80).join("\n");
      expect(withReset).toContain("Really reset Global to defaults?");

      // Confirm reset
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      // Flush async reset handler (resetScope + setValues run in microtask)
      await flushMicrotasks();

      // File should be deleted (reset removes known keys)
      expect(existsSync(join(tempDir, "flow-test-config.json"))).toBe(false);

      await promise;
    });

    it("reset in edit mode refreshes row values and keeps modal open", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Before reset: threshold is 9 (from global file)
      let out = body.render(80).join("\n");
      expect(out).toContain("9");

      // Tab to Reset and confirm
      for (let i = 0; i < 3; i++) body.handleInput?.("\t");
      body.handleInput?.("\r");
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");
      await flushMicrotasks();

      // After reset: row values refresh to defaults (threshold=5)
      out = body.render(80).join("\n");
      expect(out).toContain("5");

      await promise;
    });
  });

  // ── 7. Delete ───────────────────────────────────────────────────────

  describe("delete", () => {
    it("delete confirm → file gone → stays open", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Tab to Delete (4th action) and activate
      for (let i = 0; i < 4; i++) body.handleInput?.("\t");
      body.handleInput?.("\r");

      // Verify delete confirm rendered
      const withDelete = body.render(80).join("\n");
      expect(withDelete).toContain("Really delete the Global config file?");

      // Confirm delete
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");

      await flushMicrotasks();

      expect(existsSync(join(tempDir, "flow-test-config.json"))).toBe(false);

      await promise;
    });

    it("delete in edit mode refreshes row values and keeps modal open", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      // Before delete: threshold is 9
      let out = body.render(80).join("\n");
      expect(out).toContain("9");

      // Tab to Delete and confirm
      for (let i = 0; i < 4; i++) body.handleInput?.("\t");
      body.handleInput?.("\r");
      const confirm = getLastConfirm();
      confirm.handleInput?.("\r");
      await flushMicrotasks();

      // After delete: row values refresh to defaults (threshold=5)
      out = body.render(80).join("\n");
      expect(out).toContain("5");

      await promise;
    });
  });

  // ── 8. Session edit mode ────────────────────────────────────────────

  describe("session edit mode", () => {
    it("no Delete action; seeds from existing session overrides", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ sessionConfig: true, env: { enabled: "PI_FLOW_ENABLED" } });

      const leafEntry = {
        type: "message" as const,
        id: "leaf-1",
        parentId: null as string | null,
        timestamp: "2024-01-01T00:00:00.000Z",
        message: { role: "user" as const, content: "", timestamp: 1704110400000 },
      } as const satisfies FileEntry;
      mgr.initSession("sid", "leaf-1", [leafEntry], undefined, () => [leafEntry]);
      setSessionConfig("session-config-flow-test", tempDir, "sid", "leaf-1", { threshold: 3 });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Select session (0=display-all, 1=global, 2=project, 3=session)
      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const factory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      for (let i = 0; i < 3; i++) sel.handleInput?.("\x1b[B"); // down thrice → session
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const body = getEditBody(ctx);
      const out = body.render(80).join("\n");

      // Session title
      expect(out).toContain("FlowTest — Session");
      // No Delete action
      expect(out).not.toContain("Delete");
      // Session-seeded value visible (threshold = 3 from session override)
      expect(out).toContain("3");

      await promise;
    });
  });

  // ── 9. Display-all ──────────────────────────────────────────────────

  describe("display-all", () => {
    it("tab order: Global/Project/Env/Session/Defaults with env mappings", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });
      mgr.initSession("sid", "leaf-1", []);

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Select display-all
      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, true);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);
      const out = daBody.render(80).join("\n");
      expect(out).toContain("▸ Global");
      expect(out).toContain("Project Local");
      expect(out).toContain("Env");
      expect(out).toContain("Session");
      expect(out).toContain("Defaults");

      await promise;
    });

    it("Env tab hidden when no env mappings", async () => {
      const ctx = fakeCtx();
      const mgr = createManager(); // no env

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);
      const out = daBody.render(80).join("\n");
      expect(out).toContain("▸ Global");
      expect(out).not.toContain("Env");

      await promise;
    });

    it("Edit enabled on all display-all tabs", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });
      mgr.initSession("sid", "leaf-1", []);

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, true);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Check every tab: Edit is present and never dimmed
      const tabIds = ["Global", "Project Local", "Env", "Session", "Defaults"];
      for (let t = 0; t < tabIds.length; t++) {
        if (t > 0) daBody.handleInput?.("\t"); // Tab forward through tabs
        const out = daBody.render(80).join("\n");
        expect(out).toContain("Edit");
        expect(out).not.toContain("Edit (disabled)");
      }

      await promise;
    });

    it("display-all shows Global tab values on mount", async () => {
      writeGlobal({ threshold: 10 });
      writeProject({ enabled: false });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Global tab (initial/active tab) shows its own values
      let out = daBody.render(80).join("\n");
      expect(out).toContain("10"); // threshold from global file
      // Project value shows as inherited note on Global tab
      expect(out).toContain("(from Project Local)");

      await promise;
    });

    it("Edit jumps to viewed scope from Global tab", async () => {
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Edit is pre-focused on mount; Enter opens edit mode directly
      daBody.handleInput?.("\r");
      await Promise.resolve(); // flush microtask for openEditMode call

      // Direct path: selector + display-all + edit = 3 calls (no extra selector)
      expect(customMock).toHaveBeenCalledTimes(3);
      const editBody = getEditBody(ctx, 2);
      const out = editBody.render(80).join("\n");
      expect(out).toContain("FlowTest — Global");

      await promise;
    });

    it("Cancel closes display-all without opening edit mode", async () => {
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Navigate from Edit (pre-focused first action) to Cancel (second action)
      daBody.handleInput?.("\x1b[C"); // Right → Cancel
      daBody.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      await promise;
      // No edit mode opened
      expect(customMock).toHaveBeenCalledTimes(2);
    });

    it("Defaults Edit re-opens selector", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Tab to Defaults: 3 tabs from pre-focused Edit (Global→Project→Env→Defaults)
      for (let i = 0; i < 3; i++) daBody.handleInput?.("\t");
      daBody.handleInput?.("\r"); // Edit is already focused
      await Promise.resolve(); // flush microtasks: cleanup + selector

      // Re-opened selector is the 3rd custom call
      expect(customMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      const sel2Factory = customMock.mock.calls[2]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      let sel2: Component | undefined;
      if (!sel2Factory) {
        // Fallback: find the last factory call
        const lastIdx = customMock.mock.calls.length - 1;
        const fallback = customMock.mock.calls[lastIdx]?.[0] as (
          ...args: unknown[]
        ) => Component | undefined;
        const test = fallback?.(fakeTui(), fakeTheme(), null! as KeybindingsManager, () => {});
        if (test?.render) {
          const sel2Out = test.render(80).join("\n");
          expect(sel2Out).toContain("Configure Global settings");
        }
      } else {
        sel2 = sel2Factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
          ctx.ui.done(r);
        });
        const sel2Out = sel2.render(80).join("\n");
        expect(sel2Out).toContain("Configure Global settings");
      }

      // Cancel the re-opened selector to clean up
      sel2?.handleInput?.("\x1b");
      await ctx.ui.done(vi.fn());

      await promise;
    });

    it("Env Edit re-opens selector", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Tab to Env: 2 tabs from pre-focused Edit (Global→Project→Env)
      daBody.handleInput?.("\t");
      daBody.handleInput?.("\t");
      daBody.handleInput?.("\r"); // Edit is already focused
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Edit from non-editable scope re-opens selector (call 2 or 3 depending on cleanup timing)
      expect(customMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      // The selector is the last custom call (after any cleanup factory)
      const lastCall = customMock.mock.calls[customMock.mock.calls.length - 1]!;
      const sel2Factory = lastCall[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel2 = sel2Factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      const sel2Out = sel2.render(80).join("\n");
      expect(sel2Out).toContain("Configure Project local settings");

      sel2.handleInput?.("\x1b");
      await ctx.ui.done(vi.fn());

      await promise;
    });

    it("selector-cancel returns to display-all", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Tab to Defaults: 3 tabs from pre-focused Edit (Global→Project→Env→Defaults)
      for (let i = 0; i < 3; i++) daBody.handleInput?.("\t");
      daBody.handleInput?.("\r"); // Edit is already focused
      await Promise.resolve();

      // Re-opened selector (call 3)
      expect(customMock).toHaveBeenCalledTimes(3);
      const sel2Factory = customMock.mock.calls[2]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel2 = sel2Factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      // Cancel the re-opened selector
      sel2.handleInput?.("\x1b");
      await ctx.ui.done(vi.fn());
      await Promise.resolve(); // flush

      // Selector cancelled, flow ends
      expect(customMock).toHaveBeenCalledTimes(4);

      await promise;
    });

    it("selector→project opens project edit mode", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Tab to Defaults: 3 tabs from pre-focused Edit (Global→Project→Env→Defaults)
      for (let i = 0; i < 3; i++) daBody.handleInput?.("\t");
      daBody.handleInput?.("\r"); // Edit is already focused
      await Promise.resolve();

      // Re-opened selector (call 3)
      const sel2Factory = customMock.mock.calls[2]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel2 = sel2Factory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      // Pick Project Local from the re-opened selector (1 down from global)
      sel2.handleInput?.("\x1b[B"); // down → project
      sel2.handleInput?.("\r");
      await Promise.resolve();

      // Edit mode opens as 4th call
      expect(customMock).toHaveBeenCalledTimes(4);
      const editFactory = customMock.mock.calls[3]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const editBody = editFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      expect(editBody.render(80).join("\n")).toContain("FlowTest — Project Local");

      await promise;
    });

    it("Session tab Edit opens session edit mode directly", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ sessionConfig: true, env: { enabled: "PI_FLOW_ENABLED" } });
      mgr.initSession("sid", "leaf-1", []);

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, true);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Tab to Session (3 tabs forward from pre-focused Cancel: Cancel→Project→Env→Session),
      // Esc back to field zone, then ← enters ring at last action (Edit) while currentTabId is "session"
      for (let i = 0; i < 3; i++) daBody.handleInput?.("\t"); // Cancel→Project→Env→Session
      daBody.handleInput?.("\x1b"); // Esc → field zone
      daBody.handleInput?.("\x1b[C"); // Right → first action (Edit)
      daBody.handleInput?.("\r");
      await Promise.resolve();

      // Direct path: selector + display-all + edit = 3 calls (no extra selector)
      expect(customMock).toHaveBeenCalledTimes(3);
      const editBody = getEditBody(ctx, 2);
      expect(editBody.render(80).join("\n")).toContain("FlowTest — Session");

      await promise;
    });

    it("selector→display-all closes display-all", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Navigate from Edit (pre-focused first action) to Cancel
      daBody.handleInput?.("\x1b[C"); // Right → Cancel
      daBody.handleInput?.("\r");
      await Promise.resolve();
      await Promise.resolve();

      await promise;
      // No edit mode opened
      expect(customMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Default-true scopes ─────────────────────────────────────────

  describe("default-true scopes", () => {
    it("selector shows all scopes when scopes option is omitted", async () => {
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const out = sel.render(80).join("\n");
      expect(out).toContain("Configure Global settings");
      expect(out).toContain("Configure Project local settings");
      expect(out).toContain("Configure Session settings");

      sel.handleInput?.("\x1b");
      await promise;
    });
  });

  // ── 10. Opt-outs ────────────────────────────────────────────────────

  describe("opt-outs", () => {
    it("project: false → project dimmed in selector, absent from display-all", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({
        scopes: { global: true, project: false, session: true },
      });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      // Project is disabled in selector
      const selOut = sel.render(80).join("\n");
      expect(selOut).toContain("(disabled by extension)");
      expect(selOut).toContain("Configure Project local settings");

      // Select display-all (2 downs from global: session, display-all)
      navigateToDisplayAll(sel, false, { global: true, project: false, session: true });
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);
      const daOut = daBody.render(80).join("\n");
      expect(daOut).toContain("▸ Global");
      expect(daOut).not.toContain("Project Local");

      await promise;
    });

    it("session: false → session absent from selector and display-all", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({
        scopes: { global: true, project: true, session: false },
      });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const selOut = sel.render(80).join("\n");
      expect(selOut).toContain("(disabled by extension)");
      expect(selOut).toContain("Configure Session settings");

      // Select display-all (2 downs: project, display-all)
      navigateToDisplayAll(sel, false, { global: true, project: true, session: false });
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);
      const daOut = daBody.render(80).join("\n");
      expect(daOut).toContain("▸ Global");
      expect(daOut).not.toContain("Session");

      await promise;
    });

    it("two sequential edit sessions on different scopes do not share dirty state", async () => {
      writeGlobal({ enabled: false, threshold: 9 });
      writeProject({ enabled: true, threshold: 3 });
      const ctx = fakeCtx();
      const mgr = createManager();

      // First session: global
      const promise1 = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      await selectFirst(ctx);
      const body1 = getEditBody(ctx);
      body1.handleInput?.("\r"); // toggle → dirty
      // Discard first session
      body1.handleInput?.("\x1b");
      const confirm1 = getLastConfirm();
      confirm1.handleInput?.("\r");
      await promise1;

      // Second session: project
      const promise2 = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[customMock.mock.calls.length - 1]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      sel.handleInput?.("\x1b[B"); // down → global
      sel.handleInput?.("\x1b[B"); // down → project
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const body2 = getEditBody(ctx, customMock.mock.calls.length - 1);
      // Project should start clean (no dirty state from previous session)
      let out = body2.render(80).join("\n");
      expect(out).not.toContain("● Unsaved");

      body2.handleInput?.("\x1b"); // close
      await promise2;
    });
  });

  // ── 11. Uninitialized session ───────────────────────────────────────

  describe("uninitialized session", () => {
    it("session dimmed with (session not initialized) note", async () => {
      const ctx = fakeCtx();
      // sessionConfig enabled but initSession NOT called
      const mgr = createManager({ sessionConfig: true, env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const out = sel.render(80).join("\n");
      expect(out).toContain("Configure Session settings");
      expect(out).toContain("(session not initialized)");

      sel.handleInput?.("\x1b");
      await promise;
    });
  });

  // ── 11a. Lazy session detection ───────────────────────────────────

  describe("lazy session detection", () => {
    it("session entry available when session file exists without explicit initSession", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ sessionConfig: true, env: { enabled: "PI_FLOW_ENABLED" } });

      const sessionFile = join(tempDir, "session.jsonl");
      writeFileSync(
        sessionFile,
        '{"type":"session","version":3,"id":"sid","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}\n',
      );
      (ctx as any).sessionManager = {
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid",
        getEntries: () => [],
      };

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });

      const out = sel.render(80).join("\n");
      expect(out).toContain("Configure Session settings");
      expect(out).not.toContain("(session not initialized)");

      sel.handleInput?.("\x1b");
      await promise;
    });
  });

  // ── 12. Confirm Cancel unmounts without callbacks (C11) ─────────────

  describe("confirm callbacks", () => {
    it("Cancel in save confirm does not call onSave or close", async () => {
      writeGlobal({ enabled: true, threshold: 5 });
      const onSave = vi.fn();
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, onSave, tempDir);

      await selectFirst(ctx);
      const body = getEditBody(ctx);

      body.handleInput?.("\t"); // Save action
      body.handleInput?.("\r");

      // Cancel the save confirm (Esc)
      const confirm = getLastConfirm();
      confirm.handleInput?.("\x1b");

      await promise;

      expect(onSave).not.toHaveBeenCalled();
    });
  });

  // ── 13. Display-all value notes ─────────────────────────────────────

  describe("display-all value notes", () => {
    it("shows ▸ effective on winners and (from …) on inherited", async () => {
      writeGlobal({ threshold: 10 });
      writeProject({ enabled: false });
      const ctx = fakeCtx();
      const mgr = createManager();

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Global tab: threshold winner is global, enabled winner is project
      const globalOut = daBody.render(80).join("\n");
      expect(globalOut).toContain("▸ effective"); // threshold on Global tab
      expect(globalOut).toContain("(from Project Local)"); // enabled inherited

      await promise;
    });

    it("env tab shows env var name notes when env is set", async () => {
      process.env.PI_FLOW_ENABLED = "true";
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Switch to Env tab: from pre-focused Cancel, Tab 2 times = Project→Env
      for (let i = 0; i < 2; i++) daBody.handleInput?.("\t");
      const envOut = daBody.render(80).join("\n");
      expect(envOut).toContain("(PI_FLOW_ENABLED) ▸ effective");

      delete process.env.PI_FLOW_ENABLED;
      await promise;
    });

    it("env tab shows unset for plain string mapping", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Switch to Env tab: from pre-focused Cancel, Tab 2 times = Project→Env
      for (let i = 0; i < 2; i++) daBody.handleInput?.("\t");
      const envOut = daBody.render(80).join("\n");
      expect(envOut).toContain("(PI_FLOW_ENABLED: unset)");

      await promise;
    });

    it("env tab shows unset for EnvParser mapping", async () => {
      const ctx = fakeCtx();
      const mgr = createManager({
        env: { threshold: { var: "PI_FLOW_THRESHOLD", parse: (raw) => Number(raw) } },
      });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Switch to Env tab: from pre-focused Cancel, Tab 2 times = Project→Env
      for (let i = 0; i < 2; i++) daBody.handleInput?.("\t");
      const envOut = daBody.render(80).join("\n");
      expect(envOut).toContain("(PI_FLOW_THRESHOLD: unset)");

      await promise;
    });

    it("env tab shows unset for empty-string env var", async () => {
      process.env.PI_FLOW_ENABLED = "";
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Switch to Env tab: from pre-focused Cancel, Tab 2 times = Project→Env
      for (let i = 0; i < 2; i++) daBody.handleInput?.("\t");
      const envOut = daBody.render(80).join("\n");
      expect(envOut).toContain("(PI_FLOW_ENABLED: unset)");

      delete process.env.PI_FLOW_ENABLED;
      await promise;
    });

    it("env tab does NOT show ▸ effective when env var is set but value is invalid (boolean → non-boolean string)", async () => {
      process.env.PI_FLOW_ENABLED = "abc";
      const ctx = fakeCtx();
      const mgr = createManager({ env: { enabled: "PI_FLOW_ENABLED" } });

      const promise = mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      const customMock = ctx.ui.custom as ReturnType<typeof vi.fn>;
      const selFactory = customMock.mock.calls[0]?.[0] as (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (r: unknown) => void,
      ) => Component;
      const sel = selFactory(fakeTui(), fakeTheme(), null! as KeybindingsManager, (r) => {
        ctx.ui.done(r);
      });
      navigateToDisplayAll(sel, false);
      sel.handleInput?.("\r");
      await ctx.ui.done(vi.fn());

      const daBody = getDisplayAllBody(ctx);

      // Switch to Env tab: from pre-focused Cancel, Tab 2 times = Project→Env
      for (let i = 0; i < 2; i++) daBody.handleInput?.("\t");
      const envOut = daBody.render(80).join("\n");
      expect(envOut).not.toContain("▸ effective");
      expect(envOut).toContain("(PI_FLOW_ENABLED)");

      delete process.env.PI_FLOW_ENABLED;
      await promise;
    });
  });
});
