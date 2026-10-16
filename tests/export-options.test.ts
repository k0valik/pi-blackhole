import { describe, expect, it } from "vitest";
import type { BlackholeExportOptions } from "../src/project-recall/export-options.js";
import { parseBlackholeExportArgs } from "../src/project-recall/export-options.js";

function expectOk(args: string): BlackholeExportOptions {
  const result = parseBlackholeExportArgs(args);
  if (!result.ok) {
    throw new Error(`expected ok for ${JSON.stringify(args)}, got error: ${result.error}`);
  }
  return result.value;
}

function expectErr(args: string): string {
  const result = parseBlackholeExportArgs(args);
  if (result.ok) {
    throw new Error(
      `expected error for ${JSON.stringify(args)}, got ok: ${JSON.stringify(result.value)}`,
    );
  }
  return result.error;
}

describe("parseBlackholeExportArgs", () => {
  it("returns defaults for an empty string", () => {
    const value = expectOk("");
    expect(value.mode).toBe("distilled");
    expect(value.out).toBeUndefined();
    expect(value.days).toBeUndefined();
  });

  it("parses a relative out: path raw", () => {
    expect(expectOk("out:memory/weekly.md").out).toBe("memory/weekly.md");
  });

  it("parses an absolute out: path raw", () => {
    expect(expectOk("out:/tmp/exports/weekly.md").out).toBe("/tmp/exports/weekly.md");
  });

  it("passes out: through without .md validation", () => {
    expect(expectOk("out:notes.txt").out).toBe("notes.txt");
  });

  it("ignores a bare out: token", () => {
    expect(expectOk("out:")).toEqual({ mode: "distilled" });
  });

  it("parses days: alone", () => {
    expect(expectOk("days:7").days).toBe(7);
  });

  it("parses mode:timeline alone", () => {
    expect(expectOk("mode:timeline").mode).toBe("timeline");
  });

  it("parses explicit mode:distilled", () => {
    expect(expectOk("mode:distilled").mode).toBe("distilled");
  });

  it("parses out, days, and mode together", () => {
    expect(expectOk("days:7 mode:timeline out:memory/weekly.md")).toEqual({
      mode: "timeline",
      days: 7,
      out: "memory/weekly.md",
    });
  });

  it("ignores unrecognized tokens", () => {
    const value = expectOk("please foo:bar days:7 now");
    expect(value.days).toBe(7);
    expect(value.mode).toBe("distilled");
    expect(value.out).toBeUndefined();
  });

  it("last out: wins", () => {
    expect(expectOk("out:a.md out:b.md").out).toBe("b.md");
  });

  it("last days: wins", () => {
    expect(expectOk("days:7 days:30").days).toBe(30);
  });

  it("last mode: wins", () => {
    expect(expectOk("mode:timeline mode:distilled").mode).toBe("distilled");
  });

  it("later valid days: overrides earlier invalid days:", () => {
    expect(expectOk("days:wat days:7").days).toBe(7);
  });

  it("later invalid days: overrides earlier valid days:", () => {
    expect(expectErr("days:7 days:wat")).toMatch(/days/);
  });

  it("rejects days:0", () => {
    expect(expectErr("days:0")).toMatch(/days/);
  });

  it("rejects days:-5", () => {
    expect(expectErr("days:-5")).toMatch(/days/);
  });

  it("rejects days:1.5", () => {
    expect(expectErr("days:1.5")).toMatch(/days/);
  });

  it("rejects days:wat", () => {
    expect(expectErr("days:wat")).toMatch(/days/);
  });

  it("rejects bare days:", () => {
    expect(expectErr("days:")).toMatch(/days/);
  });

  it("rejects mode:foo", () => {
    expect(expectErr("mode:foo")).toMatch(/mode/);
  });

  it("rejects mode:Timeline as case-sensitive", () => {
    expect(expectErr("mode:Timeline")).toMatch(/mode/);
  });

  it("rejects bare mode:", () => {
    expect(expectErr("mode:")).toMatch(/mode/);
  });
});
