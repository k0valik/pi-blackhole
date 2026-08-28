/**
 * TDD tests for ConfigManager — a declarative config manager for pi extensions.
 *
 * Vertical slices — one test → one implementation → repeat.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager, type ConfigManagerOptions } from "./config-manager.ts";
import {
  deepEqual,
  checkConfigFile,
  getExtensionsDir,
  setSessionConfig,
  clearAllSessionConfigs,
} from "./config.ts";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { createSettingsModal } from "./settings/modal.ts";

// Mock the config-flow module so openSettings doesn't open a real UI
const mockOpenConfigFlow = vi.hoisted(() => vi.fn());
vi.mock("./settings/config-flow.js", () => ({
  openConfigFlow: mockOpenConfigFlow,
}));

import type { Field, SettingsModalOptions } from "./settings/types.ts";
import type { Theme, ExtensionContext, FileEntry } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────
// Session JSONL fixtures (parsed by pi's own parseSessionEntries)
// ─────────────────────────────────────────────────────────────────────

const SESSION_HEADER =
  '{"type":"session","version":3,"id":"sid-1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}\n';

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

interface TestConfig {
  enabled: boolean;
  threshold: number;
}

const DEFAULTS: TestConfig = { enabled: true, threshold: 5 };

const FIELDS = (cfg: TestConfig): Field[] => [
  { key: "enabled", type: "boolean", label: "Enabled", value: cfg.enabled },
  {
    key: "threshold",
    type: "number",
    label: "Threshold",
    value: cfg.threshold,
    min: 1,
    max: 10,
  },
];

function createManager(opts?: Partial<ConfigManagerOptions<TestConfig>>) {
  return new ConfigManager<TestConfig>({
    id: "test",
    label: "Test",
    filename: "test-config.json",
    defaults: DEFAULTS,
    fields: FIELDS,
    ...opts,
  });
}

function entriesFor(leafId: string, parentId: string | null = null): FileEntry[] {
  const parentLine = parentId
    ? `{"type":"message","id":"${parentId}","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"p"}}\n`
    : "";
  const content =
    SESSION_HEADER +
    parentLine +
    `{"type":"message","id":"${leafId}","parentId":${parentId === null ? "null" : `"${parentId}"`},"timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"user","content":"leaf"}}\n`;
  return parseSessionEntries(content);
}

function initSession(
  mgr: ConfigManager<TestConfig>,
  sessionId = "test-session",
  leafId = "leaf-1",
) {
  const fileEntries = entriesFor(leafId);
  (
    mgr as unknown as {
      initSession: (sid: string, lid: string, entries: FileEntry[]) => void;
    }
  ).initSession(sessionId, leafId, fileEntries);
}

function makeCtx(sm: Record<string, unknown> = {}) {
  const sessionManager = {
    getSessionFile: vi.fn(),
    getLeafId: vi.fn(),
    getSessionId: vi.fn(),
    getEntries: vi.fn(() => []),
    ...sm,
  } as any;
  return {
    sessionManager,
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/config-manager-test-");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeGlobal(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "test-config.json"), JSON.stringify(data));
}

function writeProject(data: Record<string, unknown>) {
  const projectDir = join(tempDir, ".pi");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "test-config.json"), JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────────────
// Tests — ConfigManager constructor
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager constructor", () => {
  it("derives filename from id when filename is omitted", () => {
    const mgr = new ConfigManager<TestConfig>({
      id: "my-ext",
      label: "MyExt",
      defaults: DEFAULTS,
      fields: FIELDS,
    });
    const result = mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    expect(result.path).toBe(join(tempDir, "my-ext-config.json"));
  });

  it("throws when neither id nor filename is provided", () => {
    const badOpts = {
      label: "NoId",
      defaults: DEFAULTS,
      fields: FIELDS,
    } as unknown as ConfigManagerOptions<TestConfig>;
    expect(() => new ConfigManager<TestConfig>(badOpts)).toThrow(
      "ConfigManager requires either `id` or `filename`",
    );
  });

  it("uses explicit filename when both id and filename are provided", () => {
    const mgr = new ConfigManager<TestConfig>({
      id: "my-ext",
      filename: "custom-config.json",
      label: "MyExt",
      defaults: DEFAULTS,
      fields: FIELDS,
    });
    const result = mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    expect(result.path).toBe(join(tempDir, "custom-config.json"));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — deepEqual
// ─────────────────────────────────────────────────────────────────────

describe("deepEqual", () => {
  it("returns true for identical primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
  });

  it("returns false for different numbers", () => {
    expect(deepEqual(1, 2)).toBe(false);
  });

  it("returns true for identical strings", () => {
    expect(deepEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(deepEqual("hello", "world")).toBe(false);
  });

  it("returns true for identical booleans", () => {
    expect(deepEqual(true, true)).toBe(true);
  });

  it("returns false for different booleans", () => {
    expect(deepEqual(true, false)).toBe(false);
  });

  it("returns true for both null", () => {
    expect(deepEqual(null, null)).toBe(true);
  });

  it("returns false for null vs object", () => {
    expect(deepEqual(null, {})).toBe(false);
  });

  it("returns false for null vs undefined", () => {
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("returns true for undefined on both sides", () => {
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it("returns true for identical arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns false for different arrays", () => {
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });

  it("returns false for arrays of different length", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("returns true for identical flat objects", () => {
    expect(deepEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
  });

  it("returns false for different flat objects", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("returns false for objects with different keys", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("returns true for nested objects", () => {
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
  });

  it("returns false for nested objects with different values", () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it("returns false for array vs object", () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — checkConfigFile
// ─────────────────────────────────────────────────────────────────────

describe("checkConfigFile", () => {
  it("returns { exists: false } when file does not exist", () => {
    const result = checkConfigFile("nonexistent.json", tempDir);
    expect(result.exists).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns valid when valid JSON object exists", () => {
    writeGlobal({ enabled: true });
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid for syntactically broken JSON", () => {
    writeFileSync(join(tempDir, "test-config.json"), "{ invalid json ");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });

  it("returns invalid for empty file", () => {
    writeFileSync(join(tempDir, "test-config.json"), "");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("returns invalid for whitespace-only file", () => {
    writeFileSync(join(tempDir, "test-config.json"), "   \n  \n  ");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("returns invalid when JSON is not a plain object (array)", () => {
    writeFileSync(join(tempDir, "test-config.json"), "[1, 2, 3]");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });

  it("returns invalid when JSON is a primitive", () => {
    writeFileSync(join(tempDir, "test-config.json"), '"hello"');
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });

  it("returns invalid when JSON is null", () => {
    writeFileSync(join(tempDir, "test-config.json"), "null");
    const result = checkConfigFile("test-config.json", tempDir);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — load()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.load()", () => {
  it("returns defaults when no config files exist", () => {
    const mgr = createManager();
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual(DEFAULTS);
  });

  it("merges global file over defaults", () => {
    writeGlobal({ threshold: 10 });
    const mgr = createManager();
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 10 });
  });

  it("merges project file over global file", () => {
    writeGlobal({ enabled: false, threshold: 3 });
    writeProject({ threshold: 7 });
    const mgr = createManager();
    const result = mgr.load(tempDir, tempDir);
    expect(result).toEqual({ enabled: false, threshold: 7 });
  });

  it("calls validate when provided", () => {
    writeGlobal({ threshold: 99 });
    const validate = vi.fn((raw: Record<string, unknown>) => ({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      threshold: typeof raw.threshold === "number" ? Math.min(10, Math.max(1, raw.threshold)) : 5,
    }));
    const mgr = createManager({ validate });
    const result = mgr.load(undefined, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 10 });
    expect(validate).toHaveBeenCalledOnce();
  });

  it("applies boolean env override", () => {
    process.env.PI_TEST_ENABLED = "false";
    const mgr = createManager({ env: { enabled: "PI_TEST_ENABLED" } });
    const result = mgr.load(undefined, tempDir);
    expect(result.enabled).toBe(false);
    delete process.env.PI_TEST_ENABLED;
  });

  it("applies integer env override via readPositiveIntEnv", () => {
    process.env.PI_TEST_THRESHOLD = "8";
    const mgr = createManager({ env: { threshold: "PI_TEST_THRESHOLD" } });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(8);
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("applies custom EnvParser override", () => {
    process.env.PI_TEST_THRESHOLD = "3.5";
    const mgr = createManager({
      defaults: { enabled: true, threshold: 5 },
      env: {
        threshold: {
          var: "PI_TEST_THRESHOLD",
          parse: (raw: string) => Math.min(10, Math.max(1, Number.parseFloat(raw))),
        },
      },
    });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(3.5);
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("env override does not apply when env var is unset", () => {
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD_UNSET" },
    });
    const result = mgr.load(undefined, tempDir);
    expect(result.threshold).toBe(DEFAULTS.threshold);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — loadWithWarnings()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.loadWithWarnings()", () => {
  it("returns config with empty warnings when all values are valid", () => {
    const mgr = createManager();
    const result = mgr.loadWithWarnings(undefined, tempDir);
    expect(result.config).toEqual(DEFAULTS);
    expect(result.warnings).toEqual([]);
  });

  it("returns warnings for invalid field values", () => {
    // Write a file with an out-of-range threshold
    writeGlobal({ threshold: 99 });
    const mgr = createManager({
      validate: (raw) => ({
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
        threshold: typeof raw.threshold === "number" ? raw.threshold : 5,
      }),
    });
    const result = mgr.loadWithWarnings(undefined, tempDir);
    expect(result.config.threshold).toBe(99);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]!.key).toBe("threshold");
    expect(result.warnings[0]!.message).toContain("10");
  });

  it("load() delegates to loadWithWarnings() and returns only config", () => {
    const mgr = createManager();
    writeGlobal({ threshold: 7 });
    const config = mgr.load(undefined, tempDir);
    expect(config).toEqual({ enabled: true, threshold: 7 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — save()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.save()", () => {
  it("writes all fields when no file existed before save", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    // No file existed → every field differs from the empty baseline
    expect(saved).toEqual({ enabled: false, threshold: 5 });
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("writes all fields when all differ from defaults (no file existed)", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 10 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 10 });
  });

  it("writes all fields when file existed but all values are new", () => {
    // File has different values → all provided values are "new" relative to file
    writeGlobal({ enabled: false, threshold: 3 });
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 7 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 7 });
  });

  it("writes only fields that changed compared to the existing file", () => {
    writeGlobal({ enabled: true, threshold: 5 });
    const mgr = createManager();
    // Only enabled changed; threshold stayed the same
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 5 });
  });

  it("does not write when file content already matches exactly", () => {
    writeGlobal({ enabled: false, threshold: 7 });
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 7 }, "global", undefined, tempDir);
    // No write needed — file is already up-to-date
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 7 });
    // File should NOT have been re-touched (mtime unchanged same content)
    const written = readFileSync(join(tempDir, "test-config.json"), "utf-8");
    expect(JSON.parse(written)).toEqual({ enabled: false, threshold: 7 });
  });

  it("writes to project directory with diff semantics", () => {
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 7 }, "project", tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 7 });
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("throws when saving to project scope without cwd", () => {
    const mgr = createManager();
    expect(() => mgr.save(DEFAULTS, "project", undefined)).toThrow("cwd");
  });

  it("preserves unknown keys from existing file alongside known diffs", () => {
    // Existing file has an unknown key + one known key override
    writeGlobal({ customFormat: true });
    const mgr = createManager();
    // Save with known key changes; unknown key should survive
    mgr.save({ enabled: false, threshold: 7 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: false, threshold: 7, customFormat: true });
  });

  it("preserves unknown keys even when known config matches defaults", () => {
    writeGlobal({ customFormat: true, extraList: [1, 2] });
    const mgr = createManager();
    // Save with exact defaults — no known keys to write, but unknown keys survive
    // Unknown keys differ from the (empty) defaults, so they get written.
    mgr.save(DEFAULTS, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({
      enabled: true,
      threshold: 5,
      customFormat: true,
      extraList: [1, 2],
    });
  });

  it("does not add phantom unknown keys when no file existed before save", () => {
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(Object.keys(saved)).toEqual(["enabled", "threshold"]);
  });

  it("preserves unknown keys in project-scoped save alongside known diffs", () => {
    writeProject({ customLabel: "test" });
    const mgr = createManager();
    mgr.save({ enabled: false, threshold: 3 }, "project", tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, ".pi", "test-config.json"), "utf-8"));
    expect(saved).toEqual({
      enabled: false,
      threshold: 3,
      customLabel: "test",
    });
  });

  it("does not overwrite unchanged known keys when only one field changed", () => {
    writeGlobal({ enabled: true, threshold: 5 });
    const mgr = createManager();
    // Only threshold changed; enabled stayed
    mgr.save({ enabled: true, threshold: 8 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    expect(saved).toEqual({ enabled: true, threshold: 8 });
  });

  it("never removes known keys that exist in the file but not in the diff", () => {
    // File has both keys, user only changed one
    writeGlobal({ enabled: false, threshold: 3 });
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 3 }, "global", undefined, tempDir);
    const saved = JSON.parse(readFileSync(join(tempDir, "test-config.json"), "utf-8"));
    // threshold: 3 matches the file, so it wasn't in the diff. But the
    // merge ({...existing, ...diff}) preserves it from existing.
    expect(saved).toEqual({ enabled: true, threshold: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — openSettings()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.openSettings()", () => {
  beforeEach(() => {
    mockOpenConfigFlow.mockReset();
  });

  it("delegates to openConfigFlow with correct params", async () => {
    const ctx = {} as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(mockOpenConfigFlow).toHaveBeenCalledTimes(1);
    const params = mockOpenConfigFlow.mock.calls[0][0];
    expect(params.label).toBe("Test");
    expect(params.scopes).toEqual({
      global: true,
      project: true,
      session: true,
    });
    expect(params.sessionInitialized).toBe(false);
    expect(params.defaults).toEqual(DEFAULTS);
    expect(params.buildFields).toBeTypeOf("function");
    expect(params.layerValues).toBeTypeOf("function");
    expect(params.inspect).toBeTypeOf("function");
    expect(params.scopeSources).toBeTypeOf("function");
    expect(params.save).toBeTypeOf("function");
    expect(params.onSaved).toBeTypeOf("function");
  });

  it("warns on malformed global JSON before delegating", async () => {
    writeFileSync(join(tempDir, "test-config.json"), "{ broken json ");
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), "warning");
    // Still delegated to the flow
    expect(mockOpenConfigFlow).toHaveBeenCalledTimes(1);
  });

  it("warns on malformed project JSON before delegating", async () => {
    writeGlobal({ enabled: true });
    const projectDir = join(tempDir, ".pi");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "test-config.json"), '{"enabled":');

    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), "warning");
    expect(mockOpenConfigFlow).toHaveBeenCalledTimes(1);
  });

  it("does not warn when both config files are valid", async () => {
    writeGlobal({ enabled: true });
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).not.toHaveBeenCalled();
    expect(mockOpenConfigFlow).toHaveBeenCalledTimes(1);
  });

  it("does not warn when no config files exist", async () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    const onUserSave = vi.fn();
    const mgr = createManager();

    await mgr.openSettings(ctx, tempDir, onUserSave, tempDir);

    expect(notify).not.toHaveBeenCalled();
    expect(mockOpenConfigFlow).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — _ensureSession()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager._ensureSession()", () => {
  beforeEach(() => {
    mockOpenConfigFlow.mockReset();
  });

  it("detects existing session via openSettings", async () => {
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-1",
      getSessionId: () => "sid-1",
      getEntries: () => entriesFor("leaf-1"),
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    expect(mgr.hasSession()).toBe(true);
  });

  it("subsequent save('session') routes through appendCustomEntry", async () => {
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const appendEntry = vi.fn();
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-1",
      getSessionId: () => "sid-1",
      getEntries: () => entriesFor("leaf-1"),
      appendCustomEntry: appendEntry,
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
    mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

    expect(appendEntry).toHaveBeenCalledWith(
      "session-config-test",
      expect.objectContaining({ leafId: "leaf-1", config: expect.any(Object) }),
    );
  });

  it("brand-new session: getSessionFile nonexistent + leafId null → pending (exercises leafId-null branch)", async () => {
    const sessionFile = join(tempDir, "nonexistent.jsonl");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => null, // leafId-null → pending (not unavailable)
      getSessionId: () => "sid-1",
      getEntries: () => [],
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    // Pending mode: session scope is available, saves go to in-memory store
    expect(mgr.hasSession()).toBe(true);
    // save('session') works in pending mode (in-memory store updated)
    const result = mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
    expect(result.changed).toBe(true);
  });

  it("header-only session: file exists but getLeafId null → pending (session scope available, sentinel key)", async () => {
    const sessionFile = join(tempDir, "empty.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => null,
      getSessionId: () => "sid-1",
      getEntries: () => [],
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    // leafId-null: file path known but no real leaf yet → pending
    expect(mgr.hasSession()).toBe(true);
    // save('session') stores under PENDING_SENTINEL
    const result = mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
    expect(result.changed).toBe(true);
  });

  it("in-memory session: getSessionFile undefined → false", async () => {
    const ctx = makeCtx({
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getSessionId: () => "sid-1",
      getEntries: () => [],
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    expect(mgr.hasSession()).toBe(false);
  });

  it("opt-out scopes.session=false → false even when session exists", async () => {
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-1",
      getSessionId: () => "sid-1",
      getEntries: () => entriesFor("leaf-1"),
    });
    const mgr = createManager({
      sessionConfig: true,
      scopes: { session: false },
    });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    expect(mgr.hasSession()).toBe(false);
  });

  it("appendCustomEntry absent → detection true, save('session') works without JSONL append", async () => {
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-1",
      getSessionId: () => "sid-1",
      getEntries: () => entriesFor("leaf-1"),
      // no appendCustomEntry
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

    expect(mgr.hasSession()).toBe(true);
    const result = mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
    expect(result.changed).toBe(true);
  });

  it("idempotent: second call no-ops", async () => {
    const sessionFile = join(tempDir, "session.jsonl");
    writeFileSync(sessionFile, SESSION_HEADER + "\n");
    const appendEntry = vi.fn();
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf-1",
      getSessionId: () => "sid-1",
      getEntries: () => entriesFor("leaf-1"),
      appendCustomEntry: appendEntry,
    });
    const mgr = createManager({ sessionConfig: true });

    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
    mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

    // appendEntry called once (only one initSession)
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  // ── Pending-mode semantics ─────────────────────────────────────────

  describe("pending mode", () => {
    it("pending: file missing but leafId known → session scope available, save works", async () => {
      const sessionFile = join(tempDir, "pending.jsonl");
      // file does NOT exist yet
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-pending",
        getEntries: () => entriesFor("leaf-1"),
        // no appendCustomEntry → stays pending even after file materializes
      });
      const mgr = createManager({ sessionConfig: true });

      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Pending: session scope is available
      expect(mgr.hasSession()).toBe(true);
      // Save works (in-memory store updated, no JSONL append)
      const result = mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(result.changed).toBe(true);
      // load() reflects the in-memory pending override
      const loaded = mgr.load(tempDir, tempDir);
      expect(loaded.threshold).toBe(8);
      expect(loaded.enabled).toBe(false);
    });

    it("pending: flush on save after file materializes", async () => {
      const sessionFile = join(tempDir, "will-materialize.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-flush",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      // Step 1: openSettings with no file → pending mode
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      expect(mgr.hasSession()).toBe(true);

      // Save in pending mode (in-memory only, no append yet)
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(appendEntry).not.toHaveBeenCalled();

      // Step 2: file materializes
      writeFileSync(sessionFile, SESSION_HEADER + "\n");

      // Next save triggers flush
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);

      // appendCustomEntry called exactly once with the leafId and config
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledWith(
        "session-config-test",
        expect.objectContaining({
          leafId: "leaf-1",
          config: expect.any(Object),
        }),
      );

      // State is now persisted
      expect(mgr.hasSession()).toBe(true);
      // Subsequent saves append directly
      appendEntry.mockClear();
      mgr.save({ enabled: false, threshold: 5 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1);
    });

    it("pending: flush on load after file materializes (no save needed)", async () => {
      const sessionFile = join(tempDir, "flush-on-load.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-load",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      // Step 1: pending mode, save some config
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(appendEntry).not.toHaveBeenCalled();

      // Step 2: file materializes
      writeFileSync(sessionFile, SESSION_HEADER + "\n");

      // load() triggers _tryFlushSession → migrates pending→persisted AND appends
      mgr.load(tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1); // flush appends on read
      expect(mgr.hasSession()).toBe(true); // state is now persisted

      // A subsequent save does NOT append again (flush already did)
      appendEntry.mockClear();
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1); // save's own append

      // Repeated loads/saves don't over-append
      mgr.load(tempDir, tempDir);
      mgr.save({ enabled: false, threshold: 5 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(2);
    });

    it("pending: flush on openSettings after file materializes (no save needed)", async () => {
      const sessionFile = join(tempDir, "flush-on-open.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-open",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      // Step 1: pending mode, save config
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(appendEntry).not.toHaveBeenCalled();

      // Step 2: file materializes
      writeFileSync(sessionFile, SESSION_HEADER + "\n");

      // Next openSettings triggers _tryFlushSession → migrates to persisted AND appends
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1); // flush appends on read
      expect(mgr.hasSession()).toBe(true); // state is persisted now

      // A subsequent save does NOT append again (flush already did)
      appendEntry.mockClear();
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1); // save's own append

      // Repeated opens don't cause extra appends
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 5 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(2);
    });

    it("pending: identity switch resets state for new session (no stale leaf)", async () => {
      const sessionFile = join(tempDir, "identity-switch.jsonl");
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      const appendEntry = vi.fn();

      // First session — pending mode (ctx1 has no appendCustomEntry)
      const ctx1 = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-old",
        getEntries: () => entriesFor("leaf-1"),
        // no appendCustomEntry → pending mode, _sessionManager stored
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctx1, tempDir, vi.fn(), tempDir);
      // pending because ctx1 has no appendCustomEntry
      expect(mgr.hasSession()).toBe(true);

      // Save pending config for sid-old via sentinel
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

      // Switch to a different sessionId (simulating in-process session switch)
      const ctx2 = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-2",
        getSessionId: () => "sid-new",
        getEntries: () => entriesFor("leaf-2"),
        appendCustomEntry: appendEntry,
      });
      await mgr.openSettings(ctx2, tempDir, vi.fn(), tempDir);

      // State re-detected for B: persisted mode (file exists + leafId + appendEntry)
      expect(mgr.hasSession()).toBe(true);
      // No stale leaf-1 config leaks through
      const loaded = mgr.load(tempDir, tempDir);
      expect(loaded.threshold).toBe(5); // defaults, not leaf-1's override
    });

    it("pending: facade missing appendCustomEntry stays pending, no throw", async () => {
      const sessionFile = join(tempDir, "no-append.jsonl");
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-no-append",
        getEntries: () => entriesFor("leaf-1"),
        // no appendCustomEntry
      });
      const mgr = createManager({ sessionConfig: true });

      // Pending mode (no appendEntry)
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      expect(mgr.hasSession()).toBe(true);

      // Repeated touches don't throw
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.load(tempDir, tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

      // Still pending (appendEntry never appeared)
      // (We can't directly check _sessionPersist, but hasSession stays true)
      expect(mgr.hasSession()).toBe(true);
    });

    it("pending: facade gains appendCustomEntry → flush succeeds", async () => {
      const sessionFile = join(tempDir, "append-appears.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-gain-append",
        getEntries: () => entriesFor("leaf-1"),
        // no appendCustomEntry initially
      });
      const mgr = createManager({ sessionConfig: true });

      // Step 1: pending without appendEntry
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      expect(mgr.hasSession()).toBe(true);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect((mgr as any)._appendEntry).toBeUndefined();

      // Step 2: facade gains appendCustomEntry AND file materializes
      (ctx.sessionManager as any).appendCustomEntry = appendEntry;
      writeFileSync(sessionFile, SESSION_HEADER + "\n"); // file materializes

      // Next save re-resolves appendEntry and flushes
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1);
    });

    it("pending: flush does not call getEntries (performance guard)", async () => {
      const sessionFile = join(tempDir, "perf-guard.jsonl");
      const getEntries = vi.fn(() => entriesFor("leaf-1"));
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-perf",
        getEntries,
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      // Pending mode
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      // Set some pending config so flush has real content to migrate
      setSessionConfig("session-config-test", tempDir, "sid-perf", "__pending__", { threshold: 3 });
      getEntries.mockClear();

      // Materialize file
      writeFileSync(sessionFile, SESSION_HEADER + "\n");

      // Trigger flush via save — _tryFlushSession must NOT call getEntries
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(getEntries).not.toHaveBeenCalled();
      expect(appendEntry).toHaveBeenCalledTimes(1);
    });

    it("pending: layerValues applies pending session overrides", async () => {
      const sessionFile = join(tempDir, "layer-pending.jsonl");
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-layer",
        getEntries: () => entriesFor("leaf-1"),
      });
      const mgr = createManager({ sessionConfig: true });

      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Set pending session config directly in the store
      setSessionConfig("session-config-test", tempDir, "sid-layer", "__pending__", {
        threshold: 3,
      });

      const result = mgr.layerValues("session", tempDir, tempDir);
      expect(result.threshold).toBe(3);
    });

    // ── F1: identity guard survives persisted state ─────────────────────

    it("pending→persisted: identity switch after flush re-detects new session, saves go to new facade", async () => {
      const sessionFile = join(tempDir, "identity-after-flush.jsonl");
      const appendEntryA = vi.fn();
      const appendEntryB = vi.fn();

      // Session A — pending mode (no appendCustomEntry initially)
      const ctxA = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-A",
        getSessionId: () => "sid-A",
        getEntries: () => entriesFor("leaf-A"),
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctxA, tempDir, vi.fn(), tempDir);
      expect(mgr.hasSession()).toBe(true);

      // Save for A (pending)
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

      // Flush: file materializes, appendEntry appears on the shared facade
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      (ctxA.sessionManager as any).appendCustomEntry = appendEntryA;
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      expect(appendEntryA).toHaveBeenCalledTimes(1);
      expect(mgr.hasSession()).toBe(true);

      // Identity switch: session B
      const ctxB = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-B",
        getSessionId: () => "sid-B",
        getEntries: () => entriesFor("leaf-B"),
        appendCustomEntry: appendEntryB,
      });
      await mgr.openSettings(ctxB, tempDir, vi.fn(), tempDir);

      // Re-detected for B: persisted mode, no stale leaf-A config
      expect(mgr.hasSession()).toBe(true);
      const loaded = mgr.load(tempDir, tempDir);
      expect(loaded.threshold).toBe(5); // defaults, not A's override
      // Saves go to B's facade
      mgr.save({ enabled: false, threshold: 9 }, "session", tempDir, tempDir);
      expect(appendEntryB).toHaveBeenCalledTimes(1);
      expect(appendEntryA).toHaveBeenCalledTimes(1); // only the earlier flush
    });

    // ── F2: cwd convergence + never append empty ────────────────────────

    it("pending: explicit cwd mismatch migrates real config on flush (no empty append)", async () => {
      const sessionFile = join(tempDir, "cwd-mismatch.jsonl");
      const detectionCwd = join(tempDir, "detect");
      const saveCwd = join(tempDir, "save");
      mkdirSync(detectionCwd, { recursive: true });
      mkdirSync(saveCwd, { recursive: true });
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-cwd",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      // openSettings with detectionCwd
      await mgr.openSettings(ctx, detectionCwd, vi.fn(), tempDir);
      // Save with explicit saveCwd (different from detectionCwd)
      mgr.save({ enabled: false, threshold: 8 }, "session", saveCwd, tempDir);

      // File materializes
      writeFileSync(sessionFile, SESSION_HEADER + "\n");

      // Flush via load with saveCwd — should migrate the real config
      mgr.load(saveCwd, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledWith(
        "session-config-test",
        expect.objectContaining({
          leafId: "leaf-1",
          config: { enabled: false, threshold: 8 },
        }),
      );
    });

    // ── F3: namespace the session store by entryType ─────────────────────

    it("pending: two managers (different entryTypes) flush independently, no cross-package bleed", async () => {
      const sessionFile = join(tempDir, "cross-pkg.jsonl");
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-cross",
        getEntries: () => entriesFor("leaf-1"),
      });

      const mgrA = createManager({ id: "pkg-a", sessionConfig: true });
      const mgrB = createManager({ id: "pkg-b", sessionConfig: true });

      await mgrA.openSettings(ctx, tempDir, vi.fn(), tempDir);
      await mgrB.openSettings(ctx, tempDir, vi.fn(), tempDir);

      // Both pending, save different configs
      mgrA.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      mgrB.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);

      // Each manager reads its own pending config via layerValues
      // (file doesn't exist so flush is a no-op)
      const layerA = mgrA.layerValues("session", tempDir, tempDir);
      const layerB = mgrB.layerValues("session", tempDir, tempDir);
      expect(layerA.threshold).toBe(8);
      expect(layerB.threshold).toBe(3);
    });

    // ── Restart recovery of a flushed entry ──────────────────────────────

    it("restart recovery: flushed entry is recovered by initSession", async () => {
      const sessionFile = join(tempDir, "recovery.jsonl");
      const appendEntry = vi.fn((type: string, data: unknown) => {
        // Actually append to the JSONL so parseSessionEntries can find it
        const line = JSON.stringify({ type: "custom", customType: type, data }) + "\n";
        writeFileSync(sessionFile, readFileSync(sessionFile, "utf-8") + line);
      });
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-recovery",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

      // Materialize: write the real session entries (header + message for leaf-1)
      // so getAncestorChain can resolve leaf-1 during recovery.
      const baseEntries = entriesFor("leaf-1");
      const baseContent = baseEntries.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(sessionFile, baseContent);
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);

      // Read the JSONL and extract the custom entry
      const jsonlContent = readFileSync(sessionFile, "utf-8");
      const entries = parseSessionEntries(jsonlContent);
      const customEntry = entries.find(
        (e) => e.type === "custom" && e.customType === "session-config-test",
      )!;
      expect(customEntry).toBeDefined();
      expect((customEntry as any).data).toEqual({
        leafId: "leaf-1",
        config: { enabled: true, threshold: 3 },
      });

      // Fresh manager: initSession with the entry
      const mgr2 = createManager({ sessionConfig: true });
      mgr2.initSession("sid-recovery", "leaf-1", entries);
      // initSession recovery writes to process.cwd(); load must match
      expect(mgr2.load(process.cwd(), tempDir).threshold).toBe(3);
      expect(mgr2.load(process.cwd(), tempDir).enabled).toBe(true);
    });

    // ── flush→reset→save ────────────────────────────────────────────────

    it("flush→reset→save: no throw, save appends directly after reset", async () => {
      const sessionFile = join(tempDir, "flush-reset-save.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-flush-reset",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);

      // Flush
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(1);

      // Reset
      mgr.resetScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(5); // defaults

      // Save again
      mgr.save({ enabled: false, threshold: 7 }, "session", tempDir, tempDir);
      expect(appendEntry).toHaveBeenCalledTimes(2); // one more append
      expect(mgr.load(tempDir, tempDir).threshold).toBe(7);
    });

    // ── reset-in-pending→flush ──────────────────────────────────────────

    it("reset-in-pending→flush: no throw, save appends after empty flush", async () => {
      const sessionFile = join(tempDir, "reset-pending-flush.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-reset-pending",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });

      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(mgr.hasSession()).toBe(true);

      // Reset in pending mode
      mgr.resetScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(5); // defaults

      // Flush (file materializes) — pending config is empty, so no append
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      mgr.save({ enabled: true, threshold: 3 }, "session", tempDir, tempDir);
      // Empty flush transitioned to persisted without appending;
      // save's own append fires for the new config
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(3);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — layerValues()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.layerValues()", () => {
  it("returns defaults + global for 'global' scope", () => {
    writeGlobal({ threshold: 10 });
    const mgr = createManager();
    const result = mgr.layerValues("global", undefined, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 10 });
  });

  it("returns defaults + global + project for 'project' scope", () => {
    writeGlobal({ threshold: 10 });
    writeProject({ threshold: 7 });
    const mgr = createManager();
    const result = mgr.layerValues("project", tempDir, tempDir);
    expect(result).toEqual({ enabled: true, threshold: 7 });
  });

  it("throws when project scope is requested without cwd", () => {
    const mgr = createManager();
    expect(() => mgr.layerValues("project", undefined, tempDir)).toThrow(
      "cwd is required for project-scoped layerValues",
    );
  });

  it("applies env overrides for 'env' scope", () => {
    process.env.PI_TEST_ENABLED = "false";
    const mgr = createManager({ env: { enabled: "PI_TEST_ENABLED" } });
    const result = mgr.layerValues("env", undefined, tempDir);
    expect(result.enabled).toBe(false);
    delete process.env.PI_TEST_ENABLED;
  });

  it("does not apply env when env var is unset for 'env' scope", () => {
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD_UNSET" },
    });
    const result = mgr.layerValues("env", undefined, tempDir);
    expect(result.threshold).toBe(DEFAULTS.threshold);
  });

  it("applies session overrides for 'session' scope", () => {
    writeGlobal({ threshold: 9 });
    const mgr = createManager({ sessionConfig: true });
    initSession(mgr);
    setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", {
      threshold: 3,
    });
    const result = mgr.layerValues("session", tempDir, tempDir);
    expect(result.threshold).toBe(3);
  });

  it("'session' scope returns 'env' result when session opted out", () => {
    process.env.PI_TEST_THRESHOLD = "8";
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD" },
      scopes: { session: false },
    });
    const sessionResult = mgr.layerValues("session", undefined, tempDir);
    const envResult = mgr.layerValues("env", undefined, tempDir);
    expect(sessionResult).toEqual(envResult);
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("applies validate at the end for all scopes", () => {
    const validate = vi.fn((raw: Record<string, unknown>) => ({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      threshold: typeof raw.threshold === "number" ? Math.min(10, Math.max(1, raw.threshold)) : 5,
    }));
    const mgr = createManager({ validate });
    writeGlobal({ threshold: 99 });
    const result = mgr.layerValues("global", undefined, tempDir);
    expect(result.threshold).toBe(10);
    expect(validate).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — inspect()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.inspect()", () => {
  it("winners: session beats env beats project beats global beats defaults", () => {
    writeGlobal({ threshold: 10 });
    writeProject({ threshold: 7 });
    process.env.PI_TEST_THRESHOLD = "8";
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD" },
      sessionConfig: true,
    });
    initSession(mgr);
    setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", {
      threshold: 3,
    });
    const result = mgr.inspect(tempDir, tempDir);
    expect(result.winners.threshold).toBe("session");
    delete process.env.PI_TEST_THRESHOLD;
  });

  it("layers contents per layer", () => {
    writeGlobal({ threshold: 10 });
    writeProject({ threshold: 7 });
    const mgr = createManager();
    const result = mgr.inspect(tempDir, tempDir);
    expect(result.layers.defaults).toEqual({ enabled: true, threshold: 5 });
    expect(result.layers.global).toEqual({ threshold: 10 });
    expect(result.layers.project).toEqual({ threshold: 7 });
    expect(result.layers.env).toEqual({});
    expect(result.layers.session).toEqual({});
  });

  it("env layer contains only env-set keys", () => {
    writeGlobal({ enabled: false, threshold: 10 });
    process.env.PI_TEST_ENABLED = "true";
    const mgr = createManager({ env: { enabled: "PI_TEST_ENABLED" } });
    const result = mgr.inspect(tempDir, tempDir);
    expect(result.layers.env).toEqual({ enabled: true });
    expect(result.layers.env).not.toHaveProperty("threshold");
    delete process.env.PI_TEST_ENABLED;
  });

  it("key only in defaults → winner 'defaults'", () => {
    const mgr = createManager();
    const result = mgr.inspect(undefined, tempDir);
    expect(result.winners.enabled).toBe("defaults");
    expect(result.winners.threshold).toBe("defaults");
  });

  it("env layer is empty when env var is unset", () => {
    const mgr = createManager({
      env: { threshold: "PI_TEST_THRESHOLD_UNSET" },
    });
    const result = mgr.inspect(undefined, tempDir);
    expect(result.layers.env).toEqual({});
  });

  it("session layer empty when session not initialized", () => {
    const mgr = createManager({ sessionConfig: true });
    const result = mgr.inspect(undefined, tempDir);
    expect(result.layers.session).toEqual({});
  });

  it("winners include keys from all layers", () => {
    writeGlobal({ threshold: 10 });
    writeProject({ enabled: false });
    process.env.PI_TEST_THRESHOLD = "8";
    const mgr = createManager({ env: { threshold: "PI_TEST_THRESHOLD" } });
    const result = mgr.inspect(tempDir, tempDir);
    expect(result.winners.enabled).toBe("project");
    expect(result.winners.threshold).toBe("env");
    delete process.env.PI_TEST_THRESHOLD;
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — scopeSources()
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.scopeSources()", () => {
  it("returns correct paths and exists flags", () => {
    writeGlobal({ threshold: 10 });
    const mgr = createManager();
    const sources = mgr.scopeSources(undefined, tempDir);
    const global = sources.find((s) => s.scope === "global")!;
    expect(global.path).toBe(join(tempDir, "test-config.json"));
    expect(global.exists).toBe(true);
    expect(global.note).toBe(join(tempDir, "test-config.json"));
  });

  it("returns nonexistent note for missing files", () => {
    const mgr = createManager();
    const sources = mgr.scopeSources(undefined, tempDir);
    const global = sources.find((s) => s.scope === "global")!;
    expect(global.exists).toBe(false);
    expect(global.note).toBe("(nonexistent — will be created on save)");
  });

  it("omits opted-out scopes", () => {
    const mgr = createManager({
      scopes: { global: true, project: false, session: false },
    });
    const sources = mgr.scopeSources(tempDir, tempDir);
    expect(sources.map((s) => s.scope)).toEqual(["global"]);
  });

  it("session note contains entry type", async () => {
    const sessionFile = join(tempDir, "scope-pending.jsonl");
    const ctx = makeCtx({
      getSessionFile: () => sessionFile,
      getLeafId: () => null,
      getSessionId: () => "sid-scope",
      getEntries: () => [],
    });
    const mgr = createManager({ sessionConfig: true });
    // openSettings triggers _ensureSession → pending mode
    await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
    const sources = mgr.scopeSources(tempDir, tempDir);
    const session = sources.find((s) => s.scope === "session")!;
    expect(session.note).toContain("will persist automatically");
    expect(session.exists).toBe(false);
  });

  it("project source uses cwd/.pi path", () => {
    const mgr = createManager();
    const sources = mgr.scopeSources(tempDir, tempDir);
    const project = sources.find((s) => s.scope === "project")!;
    expect(project.path).toBe(join(tempDir, ".pi", "test-config.json"));
    expect(project.label).toBe("Project Local");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — save() descriptor
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.save() descriptor", () => {
  it("created true on first write, false on second", () => {
    const mgr = createManager();
    const first = mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);

    const second = mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
  });

  it("changed false when saving identical values twice", () => {
    writeGlobal({ enabled: true, threshold: 5 });
    const mgr = createManager();
    mgr.save({ enabled: true, threshold: 5 }, "global", undefined, tempDir);
    const result = mgr.save({ enabled: true, threshold: 5 }, "global", undefined, tempDir);
    expect(result.changed).toBe(false);
  });

  it("session save shape", () => {
    const mgr = createManager({ sessionConfig: true });
    initSession(mgr);
    const result = mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
    expect(result).toEqual({ path: "", created: false, changed: true });
  });

  it("returns absolute path for global scope", () => {
    const mgr = createManager();
    const result = mgr.save({ enabled: false, threshold: 5 }, "global", undefined, tempDir);
    expect(result.path).toBe(join(tempDir, "test-config.json"));
  });

  it("returns absolute path for project scope", () => {
    const mgr = createManager();
    const result = mgr.save({ enabled: true, threshold: 7 }, "project", tempDir, tempDir);
    expect(result.path).toBe(join(tempDir, ".pi", "test-config.json"));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — initSession opt-out guard
// ─────────────────────────────────────────────────────────────────────

describe("ConfigManager.initSession opt-out guard", () => {
  it("scopes.session === false + initSession() → load has no session layer", () => {
    const mgr = createManager({
      sessionConfig: true,
      scopes: { session: false },
    });
    // initSession is a no-op when session is opted out
    initSession(mgr);
    setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", {
      threshold: 3,
    });
    const result = mgr.load(tempDir, tempDir);
    expect(result.threshold).toBe(DEFAULTS.threshold);
  });

  it("initSession does not set internal session state when opted out", () => {
    const mgr = createManager({
      sessionConfig: true,
      scopes: { session: false },
    });
    initSession(mgr);
    // layerValues('session') should behave like 'env' (no session state)
    const sessionResult = mgr.layerValues("session", undefined, tempDir);
    const envResult = mgr.layerValues("env", undefined, tempDir);
    expect(sessionResult).toEqual(envResult);
  });

  it("sessionConfig: false + initSession() → load has no session layer", () => {
    const mgr = createManager({
      sessionConfig: false,
      scopes: { session: true },
    });
    initSession(mgr);
    setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", {
      threshold: 3,
    });
    const result = mgr.load(tempDir, tempDir);
    expect(result.threshold).toBe(DEFAULTS.threshold);
  });

  it("initSession does not set internal session state when sessionConfig is false", () => {
    const mgr = createManager({
      sessionConfig: false,
      scopes: { session: true },
    });
    initSession(mgr);
    const sessionResult = mgr.layerValues("session", undefined, tempDir);
    const envResult = mgr.layerValues("env", undefined, tempDir);
    expect(sessionResult).toEqual(envResult);
  });
});

describe("ConfigManager session config", () => {
  beforeEach(() => {
    clearAllSessionConfigs();
  });

  afterEach(() => {
    clearAllSessionConfigs();
  });

  // Minimal 2-entry JSONL: leaf + root
  function entriesFor(leafId: string, parentId: string | null = null): FileEntry[] {
    const parentLine = parentId
      ? `{"type":"message","id":"${parentId}","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"p"}}\n`
      : "";
    const content =
      SESSION_HEADER +
      parentLine +
      `{"type":"message","id":"${leafId}","parentId":${parentId === null ? "null" : `"${parentId}"`},"timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"user","content":"leaf"}}\n`;
    return parseSessionEntries(content);
  }

  function initSession(
    mgr: ConfigManager<TestConfig>,
    sessionId = "test-session",
    leafId = "leaf-1",
  ) {
    const fileEntries = entriesFor(leafId);
    (
      mgr as unknown as {
        initSession: (sid: string, lid: string, entries: FileEntry[]) => void;
      }
    ).initSession(sessionId, leafId, fileEntries);
  }

  // ── load() priority ──────────────────────────────────────────────────

  describe("load() priority", () => {
    it("session overrides env overrides", () => {
      process.env.PI_TEST_THRESHOLD = "8";
      const mgr = createManager({
        env: { threshold: "PI_TEST_THRESHOLD" },
        sessionConfig: true,
      });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      const result = mgr.load(tempDir, tempDir);
      expect(result.threshold).toBe(3);
      delete process.env.PI_TEST_THRESHOLD;
    });

    it("session overrides project file", () => {
      writeProject({ threshold: 7 });
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      const result = mgr.load(tempDir, tempDir);
      expect(result.threshold).toBe(3);
    });

    it("session overrides global file", () => {
      writeGlobal({ threshold: 9 });
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      const result = mgr.load(tempDir, tempDir);
      expect(result.threshold).toBe(3);
    });

    it("session overrides defaults", () => {
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      const result = mgr.load(tempDir, tempDir);
      expect(result.threshold).toBe(3);
    });

    it("returns defaults when no session, file, or env config exists", () => {
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      const result = mgr.load(tempDir, tempDir);
      expect(result).toEqual(DEFAULTS);
    });

    it("does not apply session overrides when initSession not called", () => {
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      const mgr = createManager({ sessionConfig: true });
      const result = mgr.load(tempDir, tempDir);
      expect(result.threshold).toBe(DEFAULTS.threshold);
    });
  });

  // ── save() ───────────────────────────────────────────────────────────

  describe("save()", () => {
    it("saves to session store when scope is 'session'", () => {
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      const result = mgr.load(tempDir, tempDir);
      expect(result).toEqual({ enabled: false, threshold: 8 });
    });

    it("throws when saving to session scope without initSession", () => {
      const mgr = createManager({ sessionConfig: true });
      expect(() => mgr.save(DEFAULTS, "session")).toThrow("session not initialized");
    });
  });

  // ── resetScope() ─────────────────────────────────────────────────────

  describe("resetScope()", () => {
    it("clears session config for the leaf", () => {
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      expect(mgr.load(tempDir, tempDir).threshold).toBe(3);
      mgr.resetScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("clears pending sentinel key when in pending mode", async () => {
      const sessionFile = join(tempDir, "pending-reset.jsonl");
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-reset",
        getEntries: () => entriesFor("leaf-1"),
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      // pending mode: save stores under sentinel
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(8);
      // resetScope clears the sentinel key
      mgr.resetScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("clears real-leaf key after flush happened mid-session", async () => {
      const sessionFile = join(tempDir, "pending-reset-flushed.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-reset-flush",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      // pending mode, then file materializes and save triggers flush
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(8);
      // now persisted: resetScope clears the real-leaf key
      mgr.resetScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("throws when resetting session scope without initSession", () => {
      const mgr = createManager({ sessionConfig: true });
      expect(() => mgr.resetScope("session")).toThrow("session not initialized");
    });
  });

  // ── deleteScope() ────────────────────────────────────────────────────

  describe("deleteScope()", () => {
    it("clears session config for the leaf (same as reset)", () => {
      const mgr = createManager({ sessionConfig: true });
      initSession(mgr);
      setSessionConfig("session-config-test", tempDir, "test-session", "leaf-1", { threshold: 3 });
      expect(mgr.load(tempDir, tempDir).threshold).toBe(3);
      mgr.deleteScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("clears pending sentinel key when in pending mode", async () => {
      const sessionFile = join(tempDir, "pending-delete.jsonl");
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-delete",
        getEntries: () => entriesFor("leaf-1"),
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(8);
      mgr.deleteScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("clears real-leaf key after flush happened mid-session", async () => {
      const sessionFile = join(tempDir, "pending-delete-flushed.jsonl");
      const appendEntry = vi.fn();
      const ctx = makeCtx({
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-1",
        getSessionId: () => "sid-delete-flush",
        getEntries: () => entriesFor("leaf-1"),
        appendCustomEntry: appendEntry,
      });
      const mgr = createManager({ sessionConfig: true });
      await mgr.openSettings(ctx, tempDir, vi.fn(), tempDir);
      writeFileSync(sessionFile, SESSION_HEADER + "\n");
      mgr.save({ enabled: false, threshold: 8 }, "session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(8);
      mgr.deleteScope("session", tempDir, tempDir);
      expect(mgr.load(tempDir, tempDir).threshold).toBe(DEFAULTS.threshold);
    });

    it("throws when deleting session scope without initSession", () => {
      const mgr = createManager({ sessionConfig: true });
      expect(() => mgr.deleteScope("session")).toThrow("session not initialized");
    });
  });

  // ── openSettings() ───────────────────────────────────────────────────
});
