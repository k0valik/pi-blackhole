import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setTestConfigDir,
  configPath,
  DEFAULTS,
  scaffoldConfig,
} from "../src/core/unified-config.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "blackhole-scaffold-"));
  __setTestConfigDir(tempDir);
});

afterEach(() => {
  __setTestConfigDir(undefined);
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("config scaffolding", () => {
  it("creates defaults when the config is absent", () => {
    scaffoldConfig();
    expect(readFileSync(configPath(), "utf8")).toBe(`${JSON.stringify(DEFAULTS, null, 2)}\n`);
  });

  it("preserves existing config bytes", () => {
    const bytes = Buffer.from([0, 255, 10, 123, 125]);
    mkdirSync(dirname(configPath()), { recursive: true });
    realFs.writeFileSync(configPath(), bytes);
    scaffoldConfig();
    expect(readFileSync(configPath())).toEqual(bytes);
  });

  it("preserves a config created immediately before the scaffold write", () => {
    const bytes = Buffer.from("concurrent user config\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(writeFileSync).mockImplementationOnce((path, data, options) => {
      realFs.writeFileSync(path, bytes, { flag: "wx" });
      return realFs.writeFileSync(path, data, options);
    });
    scaffoldConfig();
    expect(readFileSync(configPath())).toEqual(bytes);
    expect(error).not.toHaveBeenCalled();
  });

  it("reports other write failures without throwing", () => {
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => scaffoldConfig()).not.toThrow();
    expect(error).toHaveBeenCalledWith("blackhole: config scaffold failed", failure);
  });
});
