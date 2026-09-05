import { describe, expect, it } from "vitest";
import {
  shellQuote,
  splitShellBoundary,
  stripQuotes,
  tokenizeCommand,
} from "../../src/pi-base/shell.js";

describe("shell utilities exhaustive", () => {
  describe("shellQuote", () => {
    it("should resist command injection", () => {
      expect(shellQuote("foo';cmd")).toBe("'foo'\\'';cmd'");
    });

    it("should handle expansion characters in double quotes", () => {
      // If it has expansion chars, it should be wrapped in single quotes
      expect(shellQuote('"foo$bar"')).toBe("'\"foo$bar\"'");
      expect(shellQuote('"foo`bar"')).toBe("'\"foo`bar\"'");
    });

    it("should pass through already-quoted strings safely", () => {
      expect(shellQuote("'safe'")).toBe("'safe'");
      expect(shellQuote('"safe"')).toBe('"safe"');
      // But NOT if they contain internal quotes
      expect(shellQuote("'not'safe'")).toBe("''\\''not'\\''safe'\\'''");
      expect(shellQuote('"not"safe"')).toBe('\'"not"safe"\'');
    });

    it("should handle metacharacters", () => {
      const metas = [
        " ",
        "{",
        "}",
        "(",
        ")",
        "$",
        "`",
        "!",
        "'",
        '"',
        "\\",
        "|",
        "&",
        ";",
        "<",
        ">",
        "#",
        "*",
        "?",
        "[",
        "]",
        "~",
      ];
      for (const m of metas) {
        expect(shellQuote(`a${m}b`)).toContain("'");
      }
    });

    it("should handle unicode", () => {
      expect(shellQuote("🚀")).toBe("🚀"); // No metachars in rocket
      expect(shellQuote("🚀 space")).toBe("'🚀 space'");
    });

    it("should round-trip for simple safe strings", () => {
      const cases = ["foo", "foo bar", "foo-bar", "foo/bar"];
      for (const c of cases) {
        expect(stripQuotes(shellQuote(c))).toBe(c);
      }
    });
  });

  describe("stripQuotes", () => {
    it("should handle length < 2", () => {
      expect(stripQuotes("'")).toBe("'");
      expect(stripQuotes('"')).toBe('"');
      expect(stripQuotes("")).toBe("");
    });

    it("should handle mixed quote styles", () => {
      expect(stripQuotes("'foo\"")).toBe("'foo\"");
      expect(stripQuotes("\"foo'")).toBe("\"foo'");
    });

    it("should handle unicode", () => {
      expect(stripQuotes("'🚀'")).toBe("🚀");
    });
  });

  describe("splitShellBoundary", () => {
    it("should handle all operator variants", () => {
      const ops = ["&&", "||", "|", ">", ">>", "2>", "1>&2", "<", ";"];
      for (const op of ops) {
        expect(splitShellBoundary(`cmd1 ${op} cmd2`)).toEqual(["cmd1", `${op} cmd2`]);
      }
    });

    it("should respect backslash escaping", () => {
      expect(splitShellBoundary("ls \\| grep foo")).toBeNull();
      expect(splitShellBoundary("ls \\&\\& echo hi")).toBeNull();
    });

    it("should respect quoting", () => {
      expect(splitShellBoundary("ls '|' grep foo")).toBeNull();
      expect(splitShellBoundary('ls "|" grep foo')).toBeNull();
    });

    it("should handle unicode", () => {
      expect(splitShellBoundary("echo 🚀 | grep 🚀")).toEqual(["echo 🚀", "| grep 🚀"]);
    });

    it("should return null for empty string", () => {
      expect(splitShellBoundary("")).toBeNull();
    });
  });

  describe("tokenizeCommand", () => {
    it("should handle mixed quoting", () => {
      expect(tokenizeCommand("ls -la \"dir with spaces\" 'file with spaces'")).toEqual([
        "ls",
        "-la",
        '"dir with spaces"',
        "'file with spaces'",
      ]);
    });

    it("should handle escaped characters in double quotes", () => {
      expect(tokenizeCommand('echo "quote \\" is here"')).toEqual(["echo", '"quote \\" is here"']);
    });

    it("should handle unicode", () => {
      expect(tokenizeCommand("echo 🚀 'rocket 🚀'")).toEqual(["echo", "🚀", "'rocket 🚀'"]);
    });

    it("should handle empty or whitespace string", () => {
      expect(tokenizeCommand("")).toEqual([]);
      expect(tokenizeCommand("   ")).toEqual([]);
    });
  });
});
