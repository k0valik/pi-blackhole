import { describe, it, expect } from "vitest";
import { normalizeRecallScope, parseRecallScope } from "../src/core/recall-scope.js";

describe("normalizeRecallScope", () => {
  it("defaults to active lineage", () => {
    expect(normalizeRecallScope()).toBe("lineage");
    expect(normalizeRecallScope("lineage")).toBe("lineage");
    expect(normalizeRecallScope("unknown")).toBe("lineage");
    expect(normalizeRecallScope(123)).toBe("lineage");
  });

  it("accepts all scope", () => {
    expect(normalizeRecallScope("all")).toBe("all");
    expect(normalizeRecallScope("ALL")).toBe("all");
  });
});

describe("normalizeRecallMode", () => {
  it("defaults to hybrid", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode()).toBe("hybrid");
    expect(normalizeRecallMode("unknown")).toBe("hybrid");
    expect(normalizeRecallMode(123)).toBe("hybrid");
  });

  it("accepts file mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("file")).toBe("file");
    expect(normalizeRecallMode("FILE")).toBe("file");
  });


  it("accepts hybrid mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("hybrid")).toBe("hybrid");
  });

  it("accepts touched mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("touched")).toBe("touched");
    expect(normalizeRecallMode("TOUCHED")).toBe("touched");
  });
});

describe("parseRecallScope", () => {
  it("removes scope token from command text", () => {
    expect(parseRecallScope("license scope:all page:2")).toEqual({
      scope: "all",
      mode: "hybrid",
      text: "license page:2",
    });
  });

  it("defaults to lineage when no scope token is present", () => {
    expect(parseRecallScope("license page:2")).toEqual({
      scope: "lineage",
      mode: "hybrid",
      text: "license page:2",
    });
  });

  it("parses mode token from command text", () => {
    expect(parseRecallScope("login mode:file scope:all")).toEqual({
      scope: "all",
      mode: "file",
      text: "login",
    });
  });

  it("defaults to hybrid when no mode token is present", () => {
    expect(parseRecallScope("login scope:all")).toEqual({
      scope: "all",
      mode: "hybrid",
      text: "login",
    });
  });

  it("parses touched mode from command text", () => {
    expect(parseRecallScope("mode:touched")).toEqual({
      scope: "lineage",
      mode: "touched",
      text: "",
    });
  });
});
