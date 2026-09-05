import { describe, expect, it } from "vitest";
import {
  compile,
  compileSegment,
  extractRecallNote,
  stripRecallNotes,
} from "../src/core/summarize.js";

const fileOps = { readFiles: [], modifiedFiles: [] };

describe("append VCC compilation", () => {
  it("builds a fresh segment without the prior summary or recall note", () => {
    const messages = [
      { role: "user", content: "Implement append compaction." },
      { role: "assistant", content: "Added the first immutable segment." },
    ] as any[];
    const previousSummary =
      "[Session Goal]\n- old state\n\nThe conversation before this point has been compacted.";

    const segment = compileSegment({ messages, fileOps });
    const complete = compile({ messages, previousSummary, fileOps });

    expect(segment).not.toContain("old state");
    expect(segment).not.toContain("The conversation before this point has been compacted");
    expect(complete).toContain("- old state");
    expect(extractRecallNote(complete)).toContain(
      "The conversation before this point has been compacted",
    );
  });

  it("removes every wrapped recall-note paragraph", () => {
    const text = [
      "[Goal]\nkeep",
      "The conversation before this point has been compacted, but the original\nentries remain available through recall.",
      "[Progress]\nkeep this too",
      "The conversation before this point has been compacted again.",
    ].join("\n\n");

    const cleaned = stripRecallNotes(text);
    expect(cleaned).toContain("[Goal]");
    expect(cleaned).toContain("[Progress]");
    expect(cleaned).not.toContain("conversation before this point");
  });
});
