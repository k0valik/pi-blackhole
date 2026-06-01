import { describe, test, expect } from "vitest";
import { buildOwnCut } from "../src/hooks/before-compact.js";

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

const comp = (id: string, firstKeptEntryId?: string) => ({
  id,
  type: "compaction",
  firstKeptEntryId,
});

describe("buildOwnCut", () => {

  // ── Phase 6: tailBehavior — Pi's cut support ──

  test("T19: tailBehavior pi-default with valid Pi cut — compile only removed portion", () => {
    // 3-user scenario where Pi cuts mid-session (m3), not at last user (m5).
    // Minimal would cut at m5 (last user), compiling [m1,m2,m3,m4].
    // Pi-default cuts at m3, compiling only [m1,m2].
    const r = buildOwnCut(
      [
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
        msg("m5", "user", "e"),
        msg("m6", "assistant", "f"),
      ],
      "m3",           // piFirstKeptEntryId — Pi wants to keep m3+
      "pi-default",   // tailBehavior
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.messages).toHaveLength(2); // only m1,m2 compiled (before Pi's cut)
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.compactAll).toBe(false);
  });

  test("T20: tailBehavior pi-default with Pi cut at first live message — fall through to minimal", () => {
    // Pi's cut at first live message → nothing to compile → fall through
    // With only 2 live messages, the minimal path cancels via too_few_live_messages.
    const r = buildOwnCut(
      [
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
      ],
      "m1",           // Pi cut at first message
      "pi-default",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_few_live_messages");
  });

  test("T21: tailBehavior pi-default with Pi cut not in branch — fall through to minimal/orphan", () => {
    // Pi's cut doesn't exist in branch → fall through to minimal
    // Prior compaction with valid m1 → normal resume, cut at m3 (last user)
    const r = buildOwnCut(
      [
        comp("c1", "m1"),
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      "NONEXISTENT_ID", // Pi cut not in branch
      "pi-default",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3"); // minimal cut at last user
    expect(r.messages).toHaveLength(2);   // m1,m2 compiled
  });

  test("T22: tailBehavior pi-default with no piFirstKeptEntryId — fall through to minimal", () => {
    // No Pi cut provided → fall through to minimal, cut at m3 (last user)
    const r = buildOwnCut(
      [
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      undefined,    // no Pi cut
      "pi-default",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("T26: tailBehavior pi-default with single user message — compactAll", () => {
    // Pi cut at first message → nothing to compile → fall through
    // Single user at idx 0 → compactAll
    const r = buildOwnCut(
      [
        msg("m1", "user", "go"),
        msg("m2", "assistant", "x"),
        msg("m3", "toolResult", "y"),
        msg("m4", "assistant", "z"),
      ],
      "m1",    // Pi cut at first message
      "pi-default",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
  });

  test("T27: tailBehavior pi-default with orphan firstKeptEntryId — Pi cut takes priority", () => {
    // Orphan present (ORPHAN_ID not in branch), but Pi's cut at m1 is valid.
    // liveCutIdx = 0 → fall through to minimal (no messages to compile before Pi's cut)
    const r = buildOwnCut(
      [
        msg("o1", "user", "old"),
        comp("c1", "ORPHAN_ID"),  // orphan (id not in branch)
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      "m1",    // Pi cut at m1
      "pi-default",
    );
    // Pi cut found but liveCutIdx === 0 → fall through to minimal
    // Orphan recovery collects [m1,m2,m3,m4], minimal cuts at m3
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
  });

  test("T25: tailBehavior minimal ignores Pi cut — /blackhole override behavior", () => {
    // /blackhole always uses minimal, ignoring Pi's cut guidance
    const r = buildOwnCut(
      [
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      "m1",         // Pi says keep m1+
      "minimal",    // but /blackhole uses minimal
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3"); // minimal: last user
    expect(r.messages).toHaveLength(2);
  });

  test("T23: tailBehavior pi-default with prior compaction — Pi cut takes priority over orphan recovery", () => {
    // Prior compact-all sentinel (""), but Pi's cut at m3 takes priority
    const r = buildOwnCut(
      [
        msg("o1", "user", "old"),
        msg("o2", "assistant", "old"),
        comp("c1", ""),  // prior compact-all sentinel → would trigger orphan
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      "m3",   // Pi's cut
      "pi-default",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.firstKeptEntryId).not.toBe(""); // not using compact-all sentinel
  });

  test("T24: tailBehavior minimal matches current behavior (backward compat)", () => {
    const r = buildOwnCut(
      [
        msg("m1", "user", "a"),
        msg("m2", "assistant", "b"),
        msg("m3", "user", "c"),
        msg("m4", "assistant", "d"),
      ],
      undefined,    // pi cut ignored in minimal mode
      "minimal",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });


  test("no prior compaction: cuts at last user message", () => {
    const r = buildOwnCut([
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
    expect(r.compactAll).toBe(false);
  });

  test("cancels with too_few_live_messages when liveMessages <= 2", () => {
    const r = buildOwnCut([
      comp("c1", "m1"),
      msg("m1", "user", "x"),
      msg("m2", "assistant", "y"),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_few_live_messages");
  });

  test("orphan firstKeptEntryId triggers recovery (collect after compaction)", () => {
    // Prev compaction set firstKeptEntryId to a non-existent id (e.g. "" sentinel
    // from a previous compact-all). Recovery should collect msgs after compaction.
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "ORPHAN_ID"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("resumes from firstKeptEntryId after prior compaction", () => {
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "m1"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("single user prompt + autonomous tail: compact all", () => {
    // The Discord scenario: user types 1 prompt, agent runs autonomously
    // (assistant + toolResult interleaved). No user > idx 0.
    const r = buildOwnCut([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "more"),
      msg("m5", "toolResult", "result2"),
      msg("m6", "assistant", "done"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(6);
  });

  test("no user message: compact-all instead of cancelling", () => {
    // When there are enough live messages but none are from the user
    // (e.g., long assistant/tool chain), compact all rather than
    // cancelling and leaving the session unrecoverable.
    const r = buildOwnCut([
      msg("m1", "assistant", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "assistant", "c"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(3);
  });

  test("compact-all then more chat: orphan recovery + normal cut", () => {
    // After a compact-all (firstKeptEntryId=""), user chats more turns,
    // next compaction should orphan-recover and find multiple users.
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      msg("o2", "assistant", "old"),
      comp("c1", ""), // sentinel from prior compact-all
      msg("u1", "user", "new1"),
      msg("a1", "assistant", "reply1"),
      msg("u2", "user", "new2"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "new3"),
      msg("a3", "assistant", "reply3"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u3");
    expect(r.messages).toHaveLength(4); // u1, a1, u2, a2
  });

  test("compact-all then single user msg + autonomous: compact all again", () => {
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      comp("c1", ""),
      msg("u1", "user", "okay"),
      msg("a1", "assistant", "x"),
      msg("t1", "toolResult", "y"),
      msg("a2", "assistant", "z"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
  });
});
