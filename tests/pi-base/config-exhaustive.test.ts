/**
 * Comprehensive tests for the unified config API in config.ts.
 *
 * Test strategy: use mkdtempSync for isolated directories,
 * pass via configDir. No fs mocking, no PI_CODING_AGENT_DIR stubbing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deepMerge,
  deleteConfig,
  getExtensionsDir,
  loadConfig,
  readConfig,
  writeConfig,
} from "../../src/pi-base/config.js";

// ── Helpers ─────────────────────────────────────────────────────────

function setupDirs(label: string) {
  const tmp = mkdtempSync(`/tmp/pi-config-${label}-`);
  const globalDir = join(tmp, "extensions");
  const projectDir = join(tmp, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  return {
    globalDir,
    projectDir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// ── getExtensionsDir ─────────────────────────────────────────────────

describe("getExtensionsDir", () => {
  it("returns a path ending in extensions", () => {
    const dir = getExtensionsDir();
    expect(dir).toMatch(/extensions\/?$/);
  });
});

// ── readConfig ───────────────────────────────────────────────────────

describe("readConfig", () => {
  it("returns null when file does not exist", () => {
    const { globalDir, cleanup } = setupDirs("read-nonexistent");
    expect(readConfig("nonexistent.json", globalDir)).toBeNull();
    cleanup();
  });

  it("returns parsed JSON when file exists", () => {
    const { globalDir, cleanup } = setupDirs("read-ok");
    writeFileSync(join(globalDir, "test.json"), JSON.stringify({ enabled: true, count: 42 }));
    expect(readConfig("test.json", globalDir)).toEqual({
      enabled: true,
      count: 42,
    });
    cleanup();
  });

  it("returns null for malformed JSON", () => {
    const { globalDir, cleanup } = setupDirs("read-malformed");
    writeFileSync(join(globalDir, "bad.json"), "not json");
    expect(readConfig("bad.json", globalDir)).toBeNull();
    cleanup();
  });

  it("returns null for empty file", () => {
    const { globalDir, cleanup } = setupDirs("read-empty");
    writeFileSync(join(globalDir, "empty.json"), "");
    expect(readConfig("empty.json", globalDir)).toBeNull();
    cleanup();
  });

  it("returns null when root is an array", () => {
    const { globalDir, cleanup } = setupDirs("read-array");
    writeFileSync(join(globalDir, "arr.json"), JSON.stringify([1, 2, 3]));
    expect(readConfig("arr.json", globalDir)).toBeNull();
    cleanup();
  });

  it("returns null when root is a primitive", () => {
    const { globalDir, cleanup } = setupDirs("read-primitive");
    writeFileSync(join(globalDir, "prim.json"), JSON.stringify("hello"));
    expect(readConfig("prim.json", globalDir)).toBeNull();
    cleanup();
  });
});

// ── writeConfig ──────────────────────────────────────────────────────

describe("writeConfig", () => {
  it("writes JSON and returns true", () => {
    const { globalDir, cleanup } = setupDirs("write-ok");
    const ok = writeConfig("write.json", { a: 1, b: 2 }, globalDir);
    expect(ok).toBe(true);
    expect(readConfig("write.json", globalDir)).toEqual({ a: 1, b: 2 });
    cleanup();
  });

  it("creates parent directories if needed", () => {
    const { globalDir, cleanup } = setupDirs("write-mkdir");
    const nestedDir = join(globalDir, "nested", "deep");
    const ok = writeConfig("cfg.json", { x: 1 }, nestedDir);
    expect(ok).toBe(true);
    expect(readConfig("cfg.json", nestedDir)).toEqual({ x: 1 });
    cleanup();
  });

  it("overwrites existing file", () => {
    const { globalDir, cleanup } = setupDirs("write-overwrite");
    writeFileSync(join(globalDir, "cfg.json"), JSON.stringify({ old: true }));
    writeConfig("cfg.json", { new: true }, globalDir);
    expect(readConfig("cfg.json", globalDir)).toEqual({ new: true });
    cleanup();
  });
});

// ── deleteConfig ─────────────────────────────────────────────────────

describe("deleteConfig", () => {
  it("removes file if it exists", () => {
    const { globalDir, cleanup } = setupDirs("delete-exists");
    writeFileSync(join(globalDir, "del.json"), JSON.stringify({ a: 1 }));
    deleteConfig("del.json", globalDir);
    expect(readConfig("del.json", globalDir)).toBeNull();
    cleanup();
  });

  it("does not throw if file does not exist", () => {
    const { globalDir, cleanup } = setupDirs("delete-nonexistent");
    expect(() => deleteConfig("nonexistent.json", globalDir)).not.toThrow();
    cleanup();
  });
});

// ── deepMerge ─────────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("shallow-merges flat objects", () => {
    // @ts-expect-error — testing runtime behaviour with extra properties
    expect(deepMerge({ a: 1, b: 2 }, { b: 20, c: 30 })).toEqual({
      a: 1,
      b: 20,
      c: 30,
    });
  });

  it("recursively merges nested objects", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const overrides = { a: { y: 20, z: 30 } };
    // @ts-expect-error — testing runtime behaviour with extra properties
    expect(deepMerge(base, overrides)).toEqual({
      a: { x: 1, y: 20, z: 30 },
      b: 3,
    });
  });

  it("null in overrides replaces base value", () => {
    // @ts-expect-error — testing runtime behaviour with null override
    expect(deepMerge({ a: { x: 1 } }, { a: null })).toEqual({ a: null });
  });

  it("undefined in overrides leaves base unchanged", () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it("deeply nested objects merge correctly", () => {
    const base = { a: { b: { c: 1, d: 2 } } };
    const overrides = { a: { b: { c: 10 } } };
    // @ts-expect-error — testing runtime behaviour with extra properties
    expect(deepMerge(base, overrides)).toEqual({ a: { b: { c: 10, d: 2 } } });
  });

  it("does not mutate base object", () => {
    const base = { a: { x: 1 } };
    const overrides = { a: { y: 2 } };
    // @ts-expect-error — testing runtime behaviour with extra properties
    deepMerge(base, overrides);
    expect(base.a).toEqual({ x: 1 });
  });

  it("arrays are replaced, not merged", () => {
    const base = { items: [1, 2, 3] };
    const overrides = { items: [4, 5] };
    expect(deepMerge(base, overrides)).toEqual({ items: [4, 5] });
  });
});

// ── loadConfig ────────────────────────────────────────────────────────

describe("loadConfig", () => {
  const FILENAME = "my-config.json";
  const DEFAULTS = { enabled: true, timeout: 30, label: "default" };

  it("returns defaults when no files exist", () => {
    const { globalDir, cleanup } = setupDirs("load-defaults");
    const config = loadConfig(FILENAME, DEFAULTS, { configDir: globalDir });
    expect(config).toEqual(DEFAULTS);
    cleanup();
  });

  it("merges global file with shallow defaults", () => {
    const { globalDir, cleanup } = setupDirs("load-global");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false }));
    const config = loadConfig(FILENAME, DEFAULTS, { configDir: globalDir });
    expect(config).toEqual({ enabled: false, timeout: 30, label: "default" });
    cleanup();
  });

  it("merges global + project with shallow merge", () => {
    const { globalDir, projectDir, cleanup } = setupDirs("load-global-project");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false }));
    writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ timeout: 60 }));
    const config = loadConfig(FILENAME, DEFAULTS, {
      configDir: globalDir,
      cwd: projectDir,
    });
    expect(config).toEqual({ enabled: false, timeout: 60, label: "default" });
    cleanup();
  });

  it("project overrides global (shallow)", () => {
    const { globalDir, projectDir, cleanup } = setupDirs("load-project-override");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ enabled: false }));
    writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ enabled: true }));
    const config = loadConfig(FILENAME, DEFAULTS, {
      configDir: globalDir,
      cwd: projectDir,
    });
    expect(config.enabled).toBe(true);
    cleanup();
  });

  it("gracefully handles malformed global JSON", () => {
    const { globalDir, cleanup } = setupDirs("load-malformed-global");
    writeFileSync(join(globalDir, FILENAME), "not json");
    const config = loadConfig(FILENAME, DEFAULTS, { configDir: globalDir });
    expect(config).toEqual(DEFAULTS);
    cleanup();
  });

  it("gracefully handles malformed project JSON", () => {
    const { globalDir, projectDir, cleanup } = setupDirs("load-malformed-project");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ label: "global" }));
    writeFileSync(join(projectDir, ".pi", FILENAME), "bad json");
    const config = loadConfig(FILENAME, DEFAULTS, {
      configDir: globalDir,
      cwd: projectDir,
    });
    expect(config).toEqual({ enabled: true, timeout: 30, label: "global" });
    cleanup();
  });

  it("with deep merge, recursively merges nested objects", () => {
    const { globalDir, projectDir, cleanup } = setupDirs("load-deep");
    const nestedDefaults = {
      components: { spinner: true, cwd: true, model: true },
      backends: { standard: true, tmux: false },
    };
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ components: { spinner: false } }));
    writeFileSync(join(projectDir, ".pi", FILENAME), JSON.stringify({ backends: { tmux: true } }));
    const config = loadConfig(FILENAME, nestedDefaults, {
      configDir: globalDir,
      cwd: projectDir,
      merge: "deep",
    });
    expect(config).toEqual({
      components: { spinner: false, cwd: true, model: true },
      backends: { standard: true, tmux: true },
    });
    cleanup();
  });

  it("with deep merge, project deep-overrides global", () => {
    const { globalDir, projectDir, cleanup } = setupDirs("load-deep-override");
    const nestedDefaults = { components: { spinner: true, cwd: false } };
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({ components: { spinner: false } }));
    writeFileSync(
      join(projectDir, ".pi", FILENAME),
      JSON.stringify({ components: { spinner: true } }),
    );
    const config = loadConfig(FILENAME, nestedDefaults, {
      configDir: globalDir,
      cwd: projectDir,
      merge: "deep",
    });
    expect(config.components).toEqual({ spinner: true, cwd: false });
    cleanup();
  });

  it("returns defaults when global file is empty object", () => {
    const { globalDir, cleanup } = setupDirs("load-empty-object");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify({}));
    const config = loadConfig(FILENAME, DEFAULTS, { configDir: globalDir });
    expect(config).toEqual(DEFAULTS);
    cleanup();
  });

  it("returns defaults when global file root is an array", () => {
    const { globalDir, cleanup } = setupDirs("load-array-root");
    writeFileSync(join(globalDir, FILENAME), JSON.stringify([1, 2, 3]));
    const config = loadConfig(FILENAME, DEFAULTS, { configDir: globalDir });
    expect(config).toEqual(DEFAULTS);
    cleanup();
  });
});
