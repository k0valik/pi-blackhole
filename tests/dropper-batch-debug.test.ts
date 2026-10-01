/**
 * Dropper batch-mode debug record.
 *
 * runShrunkBatches evaluates the pool in batches with rawProposals: true and
 * merges the proposals itself. That is the newest and hardest-to-debug path
 * (multi-batch, pool-wide pressure override, caller-side ranker + cap), so
 * each batch must still emit its per-batch dropper.result record — the early
 * raw return must not skip the debug block it claims to preserve.
 */
import { describe, expect, it, vi } from "vitest";

const debugEvents = vi.hoisted(() => [] as Array<{ event: string; data: any }>);

vi.mock("../src/om/debug-log.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    debugLog: (event: string, data: Record<string, unknown> = {}) => {
      debugEvents.push({ event, data });
    },
  };
});

import { runDropper } from "../src/om/agents/dropper/agent.js";
import { observation, reflection } from "./fixtures/session.js";

function scriptedLoop(batches: ReadonlyArray<Record<string, unknown>>) {
  return ((_prompts: any[], context: any, _config: any) => ({
    async *[Symbol.asyncIterator]() {
      for (const [index, batch] of batches.entries()) {
        await context.tools[0].execute(`call-${index}`, batch);
      }
      yield {
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      };
    },
    result: async () => ({}),
  })) as any;
}

describe("dropper batch-mode debug record", () => {
  it("emits a per-batch dropper.result record in rawProposals mode", async () => {
    debugEvents.length = 0;

    const proposals = await runDropper({
      model: {} as any,
      apiKey: "test",
      reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
      observations: [
        observation("aaaaaaaaaaaa", { relevance: "medium" }),
        observation("bbbbbbbbbbbb", { relevance: "low" }),
      ],
      budgetTokens: 20,
      rawProposals: true,
      agentLoop: scriptedLoop([{ ids: ["aaaaaaaaaaaa"] }]),
    });

    expect(proposals).toEqual(["aaaaaaaaaaaa"]);
    const results = debugEvents.filter((entry) => entry.event === "dropper.result");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].data).toMatchObject({
      reason: "raw_batch_proposals",
      acceptedCandidateCount: 1,
    });
  });
});
