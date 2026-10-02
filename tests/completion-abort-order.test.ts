/**
 * agentCompletionError abort/close ordering.
 *
 * A sanctioned ending (stop, or a tool close the stage already reports)
 * beats a late abort — but a live abort still beats "no message at all".
 * An abort landing before the first assistant message must report `aborted`,
 * never success (success would take the empty-close path and advance coverage
 * over entries never observed).
 */
import { describe, expect, it } from "vitest";

import { agentCompletionError } from "../src/om/agents/completion.js";

const abortedSignal = () => ({ aborted: true }) as AbortSignal;
const liveSignal = () => ({ aborted: false }) as AbortSignal;

describe("agentCompletionError abort ordering", () => {
  it("reports aborted when the signal fired with no messages", () => {
    expect(agentCompletionError([], abortedSignal())).toBe("aborted");
  });

  it("reports aborted when messages carry no stopReason", () => {
    expect(agentCompletionError([{}], abortedSignal())).toBe("aborted");
  });

  it("a stop still beats a late abort", () => {
    expect(agentCompletionError([{ stopReason: "stop" }], abortedSignal())).toBeUndefined();
  });

  it("a sanctioned tool close still beats a late abort", () => {
    expect(
      agentCompletionError([{ stopReason: "toolUse" }], abortedSignal(), true),
    ).toBeUndefined();
  });

  it("an unsanctioned tool close does not beat a live abort", () => {
    expect(agentCompletionError([{ stopReason: "toolUse" }], abortedSignal(), false)).toBe(
      "aborted",
    );
  });

  it("no abort, no messages stays success", () => {
    expect(agentCompletionError([], liveSignal())).toBeUndefined();
  });
});
