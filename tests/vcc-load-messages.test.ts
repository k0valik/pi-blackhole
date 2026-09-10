import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllMessages } from "../src/core/load-messages.js";

describe("loadAllMessages", () => {
  it("loads all message entries when no lineage filter is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-all-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: "u1" },
        }),
        JSON.stringify({ type: "custom", id: "c1", customType: "x", data: {} }),
        JSON.stringify({
          type: "message",
          id: "m2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "a1" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          message: {
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(3);
      expect(loaded.rawMessages).toHaveLength(3);
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles entries without an id field without producing "undefined" string', () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-noid-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: "u1" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "no-id entry" },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(2);
      // Neither entry should have "undefined" as its id
      expect(loaded.entryIds).not.toContain("undefined");
      // The second entry (no id) should have an empty string or some sentinel
      expect(loaded.rendered[1].id).not.toBe("undefined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters messages by allowed lineage entry IDs and preserves original message index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-filter-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: "u1" },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "a1" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          message: { role: "user", content: "u2" },
        }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false, new Set(["m2"]));
      expect(loaded.rendered).toHaveLength(1);
      expect(loaded.rawMessages).toHaveLength(1);
      expect(loaded.rendered[0].index).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadAllMessages large-file hardening (upstream pi-vcc #26)", () => {
  it("loads JSONL incrementally across read-chunk boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-chunked-"));
    const file = join(dir, "session.jsonl");
    try {
      const largeText = `${"x".repeat(70_000)} unicode: λ`;
      const lines = [
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: largeText },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          message: { role: "user", content: "after boundary" },
        }),
      ];
      // Deliberately omit the final newline to cover the buffered tail as well.
      writeFileSync(file, lines.join("\n"), "utf8");

      const loaded = loadAllMessages(file, true);
      expect(loaded.rendered).toHaveLength(2);
      expect(loaded.rendered[0].summary).toBe(largeText);
      expect(loaded.rendered[1].summary).toBe("after boundary");
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a not-yet-written session file as empty history instead of throwing ENOENT", () => {
    // Fresh session: pi has not persisted any entry, so the JSONL does not exist.
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-missing-"));
    const file = join(dir, "session.jsonl");
    try {
      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toEqual([]);
      expect(loaded.rawMessages).toEqual([]);
      expect(loaded.entryIds).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed lines without shifting later message indices", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-malformed-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        "{not json",
        "",
        JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "u2" } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(2);
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1]);
      expect(loaded.entryIds).toEqual(["m1", "m2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadGlobalIndexById agreement (same index space as recall)", () => {
  it("agrees with loadAllMessages indices on one session file", async () => {
    const { loadGlobalIndexById } = await import("../src/core/global-indices.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-index-agree-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "" }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "u2" } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      const map = loadGlobalIndexById(file);
      expect(map?.get("m1")).toBe(loaded.rendered[0].index);
      expect(map?.get("m2")).toBe(loaded.rendered[1].index);
      expect(map?.has("c1")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a not-yet-written session file", async () => {
    const { loadGlobalIndexById } = await import("../src/core/global-indices.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-index-missing-"));
    try {
      expect(loadGlobalIndexById(join(dir, "session.jsonl"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
