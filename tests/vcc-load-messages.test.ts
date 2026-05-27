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
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "custom", id: "c1", customType: "x", data: {} }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
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

  it("filters messages by allowed lineage entry IDs and preserves original message index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-filter-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "u2" } }),
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
