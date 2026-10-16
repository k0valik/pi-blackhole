import { describe, it, expect } from "vitest";
import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import { OBSERVER_SYSTEM } from "../src/om/agents/observer/prompts.js";

const MULTI = `User answers:

1. Which areas matter most? Select all worth capturing.
Selected: Response style, Autonomy and questions, Delegation
Selected preview:
SKILL TEXT SHOULD NEVER LEAK

2. Which database should we use?
Selected: Postgres`;

describe("observer path", () => {
  it("serializes the full answer text with a citable source id", () => {
    const long = "x ".repeat(2000);
    const text = `${MULTI}\nUser notes:\n${long}\nEND-OF-NOTES`;
    const { text: ser, sourceEntryIds } = serializeSourceAddressedBranchEntries([
      {
        type: "message",
        id: "e42",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "toolResult",
          toolName: "ask_user_question",
          content: [{ type: "text", text }],
          timestamp: 1,
        },
      },
    ]);
    expect(sourceEntryIds).toEqual(["e42"]);
    expect(ser).toContain("[Source entry id: e42]");
    expect(ser).toContain("[Tool result for ask_user_question");
    expect(ser).toContain("Selected: Response style, Autonomy and questions, Delegation");
    expect(ser).toContain("END-OF-NOTES");
  });

  it("observer prompt has the ask_user_question rule", () => {
    expect(OBSERVER_SYSTEM).toContain("ask_user_question");
    expect(OBSERVER_SYSTEM).toMatch(/ask_user_question[\s\S]{0,600}relevance at least high/i);
  });
});
