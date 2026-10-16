import { describe, it, expect } from "vitest";
import { extractUserDecisions, MAX_DECISIONS, NOTE_CLIP } from "../src/extract/user-decisions.js";
import { buildSections } from "../src/core/build-sections.js";
import { formatSummary } from "../src/core/format.js";
import { normalize } from "../src/core/normalize.js";
import { filterNoise } from "../src/core/filter-noise.js";
import { compile } from "../src/core/summarize.js";
import type { NormalizedBlock } from "../src/types.js";

const ask = (text: string, details?: unknown, sourceIndex = 7): NormalizedBlock => ({
  kind: "tool_result",
  name: "ask_user_question",
  text,
  isError: false,
  sourceIndex,
  ...(details ? { details } : {}),
});

const MULTI = `User answers:

1. Which areas matter most? Select all worth capturing.
Selected: Response style, Autonomy and questions, Delegation
Selected preview:
SKILL TEXT SHOULD NEVER LEAK

2. Which database should we use?
Selected: Postgres`;

describe("extractUserDecisions (text parsing)", () => {
  it("renders multi-question, multi-select answers verbatim", () => {
    expect(extractUserDecisions([ask(MULTI)])).toEqual([
      "User decided: Which areas matter most? Select all worth capturing. → Response style, Autonomy and questions, Delegation",
      "User decided: Which database should we use? → Postgres",
    ]);
  });

  it("keeps a custom answer and never leaks previews", () => {
    const out = extractUserDecisions([
      ask(
        "User answers:\n\n1. Pick a name\nAnswer: frobnicator\nSelected preview:\nSECRET PREVIEW",
      ),
    ]);
    expect(out).toEqual(["User decided: Pick a name → frobnicator"]);
  });

  it("keeps selection plus custom answer", () => {
    const out = extractUserDecisions([
      ask("User answers:\n\n1. Pick one\nSelected: A\nCustom answer: but only on Fridays"),
    ]);
    expect(out).toEqual(["User decided: Pick one → A; custom: but only on Fridays"]);
  });

  it("keeps long messy notes as a clipped, labelled user note", () => {
    const messy = Array.from({ length: 60 }, (_, i) => `- point number ${i} rambling on`).join(
      "\n",
    );
    const out = extractUserDecisions([
      ask(`User answers:\n\n1. Scope?\nSelected: Narrow\nUser notes:\n${messy}`),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].startsWith("User decided: Scope? → Narrow — user note: - point number 0")).toBe(
      true,
    );
    expect(out[0]).not.toContain("\n");
    const note = out[0].split("— user note: ")[1];
    expect(note.length).toBeLessThanOrEqual(NOTE_CLIP + 1);
    expect(note).not.toContain("point number 59");
  });

  it("does not mistake numbered lines inside notes for questions", () => {
    const out = extractUserDecisions([
      ask(
        "User answers:\n\n1. Scope?\nSelected: Narrow\nUser notes:\n2. do this first\n3. then that",
      ),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("2. do this first");
  });

  it("includes notes for selected options and the global note, not unselected ones", () => {
    const out = extractUserDecisions([
      ask(
        "User answers:\n\n1. Pick\nSelected: A\nNotes for A (selected):\nkeep it small\nNotes for B (not selected):\nIGNORED\n\nGlobal note:\nbe brief",
      ),
    ]);
    expect(out[0]).toContain("note on A: keep it small");
    expect(out[0]).not.toContain("IGNORED");
    expect(out.join("\n")).toContain("User note (global): be brief");
  });

  it("emits nothing for cancelled questionnaires", () => {
    expect(
      extractUserDecisions([
        ask(
          "The user cancelled the questionnaire. Drafts below are not confirmed answers.\n\n1. Pick\nSelected: A",
        ),
      ]),
    ).toEqual([]);
  });

  it("emits nothing for unanswered questions without notes, ignores errors and other tools", () => {
    expect(
      extractUserDecisions([
        ask("User answers:\n\n1. Pick\nNo option selected.\n\nQuestions without an answer: 1."),
        { kind: "tool_result", name: "ask_user_question", text: "boom", isError: true },
        {
          kind: "tool_result",
          name: "Read",
          text: "User answers:\n\n1. Q\nSelected: A",
          isError: false,
        },
      ]),
    ).toEqual([]);
  });

  it("keeps newest decisions within the cap", () => {
    const blocks = Array.from({ length: MAX_DECISIONS + 3 }, (_, i) =>
      ask(`User answers:\n\n1. Question ${i}\nSelected: Opt${i}`, undefined, i),
    );
    const out = extractUserDecisions(blocks);
    expect(out).toHaveLength(MAX_DECISIONS);
    expect(out[out.length - 1]).toContain(`Opt${MAX_DECISIONS + 2}`);
    expect(out[0]).toContain("Opt3");
  });
});

describe("extractUserDecisions (structured details)", () => {
  it("prefers details over text", () => {
    const out = extractUserDecisions([
      ask("garbled text", {
        cancelled: false,
        answers: [
          {
            questionIndex: 0,
            question: "Pick",
            selected: ["A", "C"],
            preview: "LEAK",
            notes: "n1",
          },
          { questionIndex: 1, question: "Name", answer: "custom one" },
          { questionIndex: 2, question: "Skipped" },
        ],
      }),
    ]);
    expect(out).toEqual([
      "User decided: Pick → A, C — user note: n1",
      "User decided: Name → custom one",
    ]);
  });

  it("emits nothing for cancelled details", () => {
    expect(
      extractUserDecisions([
        ask("x", {
          cancelled: true,
          answers: [{ questionIndex: 0, question: "Q", selected: ["A"] }],
        }),
      ]),
    ).toEqual([]);
  });
});

describe("pipeline", () => {
  const msg = {
    role: "toolResult",
    toolName: "ask_user_question",
    toolCallId: "c1",
    isError: false,
    timestamp: 1,
    content: [{ type: "text", text: MULTI }],
    details: { cancelled: false, answers: [{ questionIndex: 0, question: "Q", selected: ["Z"] }] },
  } as any;

  it("normalize carries details for ask_user_question only", () => {
    const [b] = normalize([msg]);
    expect((b as any).details).toBe(msg.details);
    const [other] = normalize([{ ...msg, toolName: "Read" }]);
    expect((other as any).details).toBeUndefined();
  });

  it("buildSections + formatSummary render a User Decisions section", () => {
    const blocks = filterNoise(normalize([{ ...msg, details: undefined }]));
    const data = buildSections({ blocks });
    expect(data.userDecisions).toHaveLength(2);
    const text = formatSummary(data);
    expect(text).toContain("[User Decisions]\n- User decided: Which areas matter most?");
    expect(text).not.toContain("SKILL TEXT");
  });

  it("survives compile() merge across compactions", () => {
    const first = compile({ messages: [msg] });
    const second = compile({
      messages: [
        {
          ...msg,
          details: undefined,
          content: [{ type: "text", text: "User answers:\n\n1. Later?\nSelected: Yes" }],
        },
      ],
      previousSummary: first,
    });
    expect(second).toContain("User decided: Q → Z");
    expect(second).toContain("User decided: Later? → Yes");
  });
});
