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
