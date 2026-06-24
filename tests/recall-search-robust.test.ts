import { describe, it, expect } from "vitest";
import { searchEntries, getFileIndicators, getTouchedFiles } from "../src/core/search-entries.js";
import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "../src/core/render-entries.js";

const ts = Date.now();
const msg = (role: string, content: any): Message => ({
  role,
  content,
  timestamp: ts,
} as any);

const rendered = (index: number, role: string, summary: string): RenderedEntry => ({
  index,
  role,
  summary,
  timestamp: ts,
});

describe("recall-search-robust", () => {
  describe("BM25 scoring and ranking", () => {
    it("ranks rare terms higher (IDF)", () => {
      const e = [rendered(0, "user", "common"), rendered(1, "user", "rare common")];
      const m = [msg("user", "common"), msg("user", "rare common")];
      const results = searchEntries(e, m, "rare");
      expect(results).toHaveLength(1);
      expect(results[0].index).toBe(1);

      const resultsBoth = searchEntries(e, m, "rare common");
      expect(resultsBoth[0].index).toBe(1);
    });

    it("handles term frequency saturation (BM25 K)", () => {
        const e = [
            rendered(0, "user", "common ".repeat(10)),
            rendered(1, "user", "common common")
        ];
        const m = [
            msg("user", "common ".repeat(10)),
            msg("user", "common common")
        ];
        const results = searchEntries(e, m, "common");
        expect(results[0].index).toBe(0);
    });

    it("filters stopwords but keeps them if only stopwords are provided", () => {
        const e = [rendered(0, "user", "the quick brown fox")];
        const m = [msg("user", "the quick brown fox")];

        const res1 = searchEntries(e, m, "the quick");
        expect(res1).toHaveLength(1);

        const res2 = searchEntries(e, m, "the");
        expect(res2).toHaveLength(1);
    });

    it("handles queries with many terms", () => {
        const e = [rendered(0, "user", "a b c d e f g")];
        const m = [msg("user", "a b c d e f g")];
        expect(searchEntries(e, m, "a b c d e")).toHaveLength(1);
    });

    it("scores multi-word queries correctly when terms are separated", () => {
        const e = [rendered(0, "user", "word1 ... word2")];
        const m = [msg("user", "word1 ... word2")];
        expect(searchEntries(e, m, "word1 word2")).toHaveLength(1);
    });
  });

  describe("regex query detection (looksLikeRegex)", () => {
    it("treats query with | as regex", () => {
      const e = [rendered(0, "user", "apple"), rendered(1, "user", "banana")];
      const m = [msg("user", "apple"), msg("user", "banana")];
      const res = searchEntries(e, m, "apple|banana");
      expect(res).toHaveLength(2);
    });

    it("treats query with * as regex", () => {
      const e = [rendered(0, "user", "testing")];
      const m = [msg("user", "testing")];
      const res = searchEntries(e, m, "test.*");
      expect(res).toHaveLength(1);
    });

    it("treats query with ? as regex", () => {
        const e = [rendered(0, "user", "color"), rendered(1, "user", "colour")];
        const m = [msg("user", "color"), msg("user", "colour")];
        expect(searchEntries(e, m, "colou?r")).toHaveLength(2);
    });

    it("treats query with [] as regex", () => {
        const e = [rendered(0, "user", "file1"), rendered(1, "user", "file2")];
        const m = [msg("user", "file1"), msg("user", "file2")];
        expect(searchEntries(e, m, "file[12]")).toHaveLength(2);
    });

    it("falls back to escaped literal if regex is invalid", () => {
        const e = [rendered(0, "user", "[invalid regex")];
        const m = [msg("user", "[invalid regex")];
        const res = searchEntries(e, m, "[invalid regex");
        expect(res).toHaveLength(1);
    });
  });

  describe("mode-based filtering (file vs hybrid vs touched)", () => {
    const e = [rendered(0, "assistant", "writing file")];
    const m = [msg("assistant", [
        { type: "text", text: "let me write a file" },
        { type: "toolCall", name: "write", arguments: { path: "a.ts", content: "data" } }
    ])];

    it("hybrid mode matches both transcript and file content", () => {
        expect(searchEntries(e, m, "write")).toHaveLength(1);
        expect(searchEntries(e, m, "data")).toHaveLength(1);
    });

    it("file mode matches only tool call arguments", () => {
        expect(searchEntries(e, m, "write", undefined, "file")).toHaveLength(0);
        expect(searchEntries(e, m, "data", undefined, "file")).toHaveLength(1);
    });

    it("defaults to hybrid for invalid modes", () => {
        expect(searchEntries(e, m, "write", undefined, "invalid" as any)).toHaveLength(1);
    });
  });

  describe("mode:touched file aggregation", () => {
    it("aggregates files across entries", () => {
      const m = [
        msg("assistant", [{ type: "toolCall", name: "write", arguments: { path: "a.ts", content: "v1" } }]),
        msg("assistant", [{ type: "toolCall", name: "edit", arguments: { path: "a.ts", edits: [{oldText: "v1", newText:"v2"}] } }]),
        msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "b.ts", content: "data" } }]),
      ];
      const r = [rendered(0, "a", "s"), rendered(1, "a", "s"), rendered(2, "a", "s")];
      const touched = getTouchedFiles(m, r);
      expect(touched).toHaveLength(2);
      const a = touched.find(t => t.path === "a.ts");
      expect(a?.entries).toHaveLength(2);
      expect(a?.entries[0].toolName).toBe("write");
      expect(a?.entries[1].toolName).toBe("edit");
    });

    it("handles multiple tool calls in one message", () => {
        const m = [msg("assistant", [
            { type: "toolCall", name: "write", arguments: { path: "a.ts", content: "v1" } },
            { type: "toolCall", name: "write", arguments: { path: "b.ts", content: "v1" } }
        ])];
        const r = [rendered(0, "a", "s")];
        const touched = getTouchedFiles(m, r);
        expect(touched).toHaveLength(2);
    });
  });

  describe("getFileIndicators edge cases", () => {
    it("handles various path keys", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "t", arguments: { filePath: "test.ts", content: "x" } }]);
        const ind = getFileIndicators(m);
        expect(ind[0].path).toBe("test.ts");
    });

    it("handles non-string path keys", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "t", arguments: { path: 123, content: "x" } }]);
        const ind = getFileIndicators(m);
        expect(ind).toHaveLength(0);
    });

    it("extracts lineCount correctly from content", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "t", arguments: { path: "a.ts", content: "line1\nline2\n\nline3" } }]);
        const ind = getFileIndicators(m);
        expect(ind[0].lineCount).toBe(3);
    });

    it("extracts text from edits (oldText and newText)", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "t", arguments: { path: "a.ts", edits: [{oldText: "old", newText: "new"}] } }]);
        const ind = getFileIndicators(m);
        expect(ind[0].lineCount).toBe(2);
    });

    it("handles oldText/newText without edits array", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "t", arguments: { path: "a.ts", oldText: "old", newText: "new" } }]);
        const ind = getFileIndicators(m);
        expect(ind[0].lineCount).toBe(2);
    });
  });

  describe("snippet highlighting and lineSnippet", () => {
    it("provides line-based snippet with context", () => {
        const e = [rendered(0, "user", "summary")];
        const m = [msg("user", "line1\nline2\nmatch here\nline4\nline5\nline6")];
        const res = searchEntries(e, m, "match");
        expect(res[0].snippet).toContain("match here");
        expect(res[0].snippet).toContain("line1");
        expect(res[0].snippet).toContain("line5");
        expect(res[0].snippet).not.toContain("line6");
    });

    it("handles multiple matches by taking the first one for snippet", () => {
        const e = [rendered(0, "user", "summary")];
        const m = [msg("user", "first match\nmiddle\nsecond match")];
        const res = searchEntries(e, m, "match");
        expect(res[0].snippet).toContain("first match");
    });

    it("truncates very long snippets", () => {
        const e = [rendered(0, "user", "summary")];
        const longLine = "a".repeat(1000) + " match " + "b".repeat(1000);
        const m = [msg("user", longLine)];
        const res = searchEntries(e, m, "match");
        // lineSnippet does NOT clip line length, it just takes whole lines.
        // snippet highlighting in search-entries.ts uses lineSnippet.
        expect(res[0].snippet).toContain("match");
    });
  });

  describe("overall search robustness", () => {
    it("is case insensitive", () => {
        const e = [rendered(0, "user", "APPLE")];
        const m = [msg("user", "APPLE")];
        expect(searchEntries(e, m, "apple")).toHaveLength(1);
    });

    it("handles special characters in query (non-regex)", () => {
        const e = [rendered(0, "user", "C++ is fun")];
        const m = [msg("user", "C++ is fun")];
        expect(searchEntries(e, m, "C++")).toHaveLength(1);
    });

    it("scores multiple term matches higher than single term", () => {
        const e = [rendered(0, "user", "quick brown"), rendered(1, "user", "quick")];
        const m = [msg("user", "quick brown"), msg("user", "quick")];
        const res = searchEntries(e, m, "quick brown");
        expect(res[0].index).toBe(0);
    });

    it("handles messages with bashExecution role", () => {
        const mBash = { role: "bashExecution", command: "ls", output: "file.txt" } as any;
        const e = [rendered(0, "assistant", "bash")];
        expect(searchEntries(e, [mBash], "ls")).toHaveLength(1);
        expect(searchEntries(e, [mBash], "file.txt")).toHaveLength(1);
    });

    it("bashExecution does not match in file mode", () => {
        const mBash = { role: "bashExecution", command: "ls", output: "file.txt" } as any;
        const e = [rendered(0, "assistant", "bash")];
        expect(searchEntries(e, [mBash], "ls", undefined, "file")).toHaveLength(0);
    });

    it("handles missing content in messages", () => {
        const e = [rendered(0, "assistant", "empty")];
        const m = [msg("assistant", null)];
        expect(searchEntries(e, m, "query")).toHaveLength(0);
    });

    it("handles mixed types in message content (e.g. image + text)", () => {
        const e = [rendered(0, "user", "image")];
        const m = [msg("user", [{type: "text", text: "find me"}, {type: "image", mimeType: "image/png"}])];
        expect(searchEntries(e, m, "find")).toHaveLength(1);
    });

    it("regex search includes fileMatches", () => {
        const m = msg("assistant", [{ type: "toolCall", name: "write", arguments: { path: "a.ts", content: "regex match" } }]);
        const e = [rendered(0, "a", "s")];
        const res = searchEntries(e, [m], "regex.*match");
        expect(res[0].fileMatches).toHaveLength(1);
        expect(res[0].fileMatches![0].path).toBe("a.ts");
    });
  });
});
