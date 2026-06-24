import { describe, it, expect } from "vitest";
import { buildOwnCut } from "../src/hooks/before-compact.js";

const msg = (id: string, role: string) => ({ id, type: "message", message: { role, content: "text" } });
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });

describe("buildOwnCut", () => {
  describe("basic cutting (minimal mode)", () => {
    it("compacts everything and keeps last user message", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.firstKeptEntryId).toBe("3");
        expect(res.messages).toHaveLength(2); // msg 1 and 2
        expect(res.compactAll).toBe(false);
      }
    });

    it("compactAll when only one user message exists at index 0", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.compactAll).toBe(true);
        expect(res.firstKeptEntryId).toBe("");
        expect(res.messages).toHaveLength(3);
      }
    });

    it("compactAll when no user message exists", () => {
      const entries = [
        msg("1", "assistant"),
        msg("2", "assistant"),
        msg("3", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.compactAll).toBe(true);
        expect(res.messages).toHaveLength(3);
      }
    });

    it("cancels if too few live messages (<= 2)", () => {
      const entries = [msg("1", "user"), msg("2", "assistant")];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("too_few_live_messages");
    });
  });

  describe("orphan recovery (missing or invalid lastKeptId)", () => {
    it("triggers when lastKeptId is empty sentinel from prior compactAll", () => {
      const entries = [
        comp("0", ""),
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.firstKeptEntryId).toBe("3");
        expect(res.messages).toHaveLength(2); // 1, 2
      }
    });

    it("triggers when lastKeptId refers to non-existent entry", () => {
      const entries = [
        comp("0", "gone"),
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.firstKeptEntryId).toBe("3");
        expect(res.messages).toHaveLength(2);
      }
    });

    it("starts after the LAST compaction entry found in branch", () => {
      const entries = [
        comp("0", "1"),
        msg("1", "user"),
        comp("1.5", "invalid"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
      ];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.messages).toHaveLength(1); // Only msg 2 (msg 1 is before the last compaction entry)
        expect(res.firstKeptEntryId).toBe("3");
      }
    });
  });

  describe("pi-default tail behavior", () => {
    it("respects piFirstKeptEntryId if found in branch", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
        msg("5", "user"),
      ];
      // Pi wants to keep from msg 3 onwards
      const res = buildOwnCut(entries, "3", "pi-default");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.firstKeptEntryId).toBe("3");
        expect(res.messages).toHaveLength(2); // 1, 2
      }
    });

    it("resolves to next message if piFirstKeptEntryId points to non-message entry", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        { id: "3", type: "custom" },
        msg("4", "user"),
        msg("5", "assistant"),
      ];
      const res = buildOwnCut(entries, "3", "pi-default");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.firstKeptEntryId).toBe("4");
        expect(res.messages).toHaveLength(2); // 1, 2
      }
    });

    it("cancels if Pi's cut would violate minimal path by keeping multiple user messages", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
        msg("5", "user"),
      ];
      // Pi wants to keep everything (cut at 1)
      const res = buildOwnCut(entries, "1", "pi-default");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("too_few_live_messages");
    });

    it("falls through to minimal if piFirstKeptEntryId not in branch", () => {
      const entries = [
        msg("1", "user"),
        msg("2", "assistant"),
        msg("3", "user"),
        msg("4", "assistant"),
      ];
      const res = buildOwnCut(entries, "99", "pi-default");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.firstKeptEntryId).toBe("3");
    });

    it("falls through to minimal if piFirstKeptEntryId is undefined", () => {
        const entries = [msg("1", "user"), msg("2", "assistant"), msg("3", "user"), msg("4", "assistant")];
        const res = buildOwnCut(entries, undefined, "pi-default");
        expect(res.ok).toBe(true);
        expect(res.firstKeptEntryId).toBe("3");
    });
  });

  describe("robustness and edge cases", () => {
    it("handles branch with no messages", () => {
      const res = buildOwnCut([{ id: "1", type: "custom" }], undefined, "minimal");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("no_live_messages");
    });

    it("handles already compacted branch with no new messages", () => {
      const entries = [comp("1", "2"), msg("2", "user"), msg("3", "assistant")];
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(false); // only 2 live messages (2 and 3)
    });

    it("handles very long assistant chain (no user message)", () => {
      const entries = Array.from({ length: 10 }, (_, i) => msg(String(i), "assistant"));
      const res = buildOwnCut(entries, undefined, "minimal");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.compactAll).toBe(true);
    });

    it("correctly identifies last user message when tail is assistant/tool", () => {
        const entries = [
            msg("1", "user"),
            msg("2", "assistant"),
            msg("3", "user"),
            msg("4", "assistant"),
            { id: "5", type: "message", message: { role: "toolResult", content: "ok" } }
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.firstKeptEntryId).toBe("3");
    });

    it("handles multiple compaction entries in a row", () => {
        const entries = [
            comp("1", "0"),
            comp("2", ""),
            msg("3", "user"),
            msg("4", "assistant"),
            msg("5", "user"),
            msg("6", "assistant")
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.firstKeptEntryId).toBe("5");
            expect(res.messages).toHaveLength(2); // 3, 4
        }
    });

    it("orphan recovery with no prior compaction behaves like normal start", () => {
        const entries = [msg("1", "user"), msg("2", "assistant"), msg("3", "user"), msg("4", "assistant")];
        // No compaction found, foundKept becomes true immediately
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.firstKeptEntryId).toBe("3");
    });

    it("compactAll when last user is at index 0 and branch is long", () => {
        const entries = [
            msg("0", "user"),
            ...Array.from({length: 10}, (_, i) => msg(String(i+1), "assistant"))
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.compactAll).toBe(true);
            expect(res.firstKeptEntryId).toBe("");
        }
    });

    it("tailBehavior minimal ignores Pi's cut even if provided", () => {
        const entries = [
            msg("1", "user"),
            msg("2", "assistant"),
            msg("3", "user"),
            msg("4", "assistant"),
            msg("5", "user")
        ];
        // Pi wants to keep from 3, but mode is minimal
        const res = buildOwnCut(entries, "3", "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.firstKeptEntryId).toBe("5");
    });

    it("pi-default behavior with invalid resolvedId falls through", () => {
        const entries = [
            msg("1", "user"),
            msg("2", "assistant"),
            comp("3", "1")
        ];
        // Pi says cut at 3 (compaction), no messages after 3.
        const res = buildOwnCut(entries, "3", "pi-default");
        // Should fall through to minimal/orphan recovery and likely fail or compactAll
        // In this case, orphan recovery triggers because 3 is compaction.
        // liveMessages will be empty after 3.
        expect(res.ok).toBe(false);
    });

    it("preserves tool results in messages to summarize", () => {
        const entries = [
            msg("1", "user"),
            { id: "2", type: "message", message: { role: "assistant", content: [{type:"toolCall", name:"t"}] } },
            { id: "3", type: "message", message: { role: "toolResult", name:"t", content: "r" } },
            msg("4", "user"),
            msg("5", "assistant")
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.messages).toHaveLength(3);
            expect((res.messages[1] as any).role).toBe("assistant");
            expect((res.messages[2] as any).role).toBe("toolResult");
        }
    });

    it("handles message with no role or content gracefully (if it bypasses types)", () => {
        const entries = [
            msg("1", "user"),
            { id: "2", type: "message", message: {} } as any,
            msg("3", "user"),
            msg("4", "assistant")
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.messages).toHaveLength(2);
    });

    it("orphan recovery with mixed entries after last compaction", () => {
        const entries = [
            comp("1", "gone"),
            { id: "2", type: "custom" },
            msg("3", "user"),
            { id: "4", type: "custom" },
            msg("5", "assistant"),
            msg("6", "user"),
            msg("7", "assistant")
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.messages).toHaveLength(2); // 3 and 5
            expect(res.firstKeptEntryId).toBe("6");
        }
    });

    it("pi-default resolves next message when Pi's cut is precisely before it", () => {
        const entries = [
            msg("1", "user"),
            { id: "2", type: "custom" },
            msg("3", "user"),
            msg("4", "assistant")
        ];
        // Pi cut at custom entry 2
        const res = buildOwnCut(entries, "2", "pi-default");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.firstKeptEntryId).toBe("3");
            expect(res.messages).toHaveLength(1); // just msg 1
        }
    });

    it("cancels if Pi's cut is at the very first message and multiple user messages exist", () => {
        const entries = [msg("1", "user"), msg("2", "user"), msg("3", "user")];
        const res = buildOwnCut(entries, "1", "pi-default");
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("too_few_live_messages");
    });

    it("handles firstKeptEntryId='' sentinel and triggers orphan recovery on next call", () => {
        // firstKeptEntryId='' is what buildOwnCut returns for compactAll.
        const entries = [
            comp("1", ""),
            msg("2", "user"),
            msg("3", "assistant"),
            msg("4", "user"),
            msg("5", "assistant")
        ];
        const res = buildOwnCut(entries, undefined, "minimal");
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.firstKeptEntryId).toBe("4");
            expect(res.messages).toHaveLength(2); // 2, 3
        }
    });
  });
});
