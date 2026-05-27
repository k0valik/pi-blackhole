/**
 * Ported from upstream pi-vcc
 * Changes: bun:test → vitest, added .js import extensions
 */
import { describe, it, expect } from "vitest";
import { sanitize } from "../src/core/sanitize.js";

describe("sanitize", () => {
  it("strips ANSI escape codes", () => {
    expect(sanitize("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("normalizes CRLF to LF", () => {
    expect(sanitize("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("strips bare CR", () => {
    expect(sanitize("a\rb")).toBe("a\nb");
  });

  it("strips control characters but preserves newlines and tabs", () => {
    expect(sanitize("a\x00b\tc\nd")).toBe("ab\tc\nd");
  });

  it("passes clean text unchanged", () => {
    expect(sanitize("hello world")).toBe("hello world");
  });
});
