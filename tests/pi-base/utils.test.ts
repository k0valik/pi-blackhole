import { describe, expect, it, vi } from "vitest";
import { readBooleanEnv, readPositiveIntEnv } from "../../src/pi-base/config.js";
import {
  shellQuote,
  splitShellBoundary,
  stripQuotes,
  tokenizeCommand,
} from "../../src/pi-base/shell.js";

describe("pi-base utilities", () => {
  describe("types", () => {
    it("isRecord should identify Record<string, unknown> values", async () => {
      const { isRecord } = await import("../../src/pi-base/types.js");
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(null)).toBe(false);
      expect(isRecord([1, 2])).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });
  });

  describe("shell", () => {
    it("should tokenize commands correctly", () => {
      expect(tokenizeCommand('ls -la "file name"')).toEqual(["ls", "-la", '"file name"']);
      expect(tokenizeCommand("echo 'hello world'")).toEqual(["echo", "'hello world'"]);
    });

    it("should split shell boundaries", () => {
      expect(splitShellBoundary("ls | grep foo")).toEqual(["ls", "| grep foo"]);
      expect(splitShellBoundary("cat file > out")).toEqual(["cat file", "> out"]);
      expect(splitShellBoundary("cmd1 && cmd2")).toEqual(["cmd1", "&& cmd2"]);
    });

    it("shellQuote should wrap values in single quotes", () => {
      expect(shellQuote("*.ts")).toBe("'*.ts'");
      expect(shellQuote("foo bar")).toBe("'foo bar'");
      // Values without metacharacters are returned unchanged
      expect(shellQuote("simple")).toBe("simple");
      expect(shellQuote("'pre-quoted'")).toBe("'pre-quoted'");
      expect(shellQuote('"double"')).toBe('"double"');
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    });

    it("stripQuotes should remove surrounding quotes", () => {
      expect(stripQuotes("'quoted'")).toBe("quoted");
      expect(stripQuotes('"double"')).toBe("double");
      expect(stripQuotes("bare")).toBe("bare");
      // Single quote is not a quoted pair - left as-is
      expect(stripQuotes("'")).toBe("'");
      expect(stripQuotes("''")).toBe("");
    });
  });

  describe("config", () => {
    it("should read boolean env", () => {
      vi.stubEnv("TEST_BOOL_TRUE", "true");
      vi.stubEnv("TEST_BOOL_FALSE", "0");
      expect(readBooleanEnv("TEST_BOOL_TRUE", false)).toBe(true);
      expect(readBooleanEnv("TEST_BOOL_FALSE", true)).toBe(false);
      expect(readBooleanEnv("TEST_NON_EXISTENT", true)).toBe(true);
      vi.unstubAllEnvs();
    });

    it("should read positive int env", () => {
      vi.stubEnv("TEST_INT", "100");
      vi.stubEnv("TEST_INVALID_INT", "abc");
      expect(readPositiveIntEnv("TEST_INT", 10)).toBe(100);
      expect(readPositiveIntEnv("TEST_INVALID_INT", 10)).toBe(10);
      vi.unstubAllEnvs();
    });
  });
});
