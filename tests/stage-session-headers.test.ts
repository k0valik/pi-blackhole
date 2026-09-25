/**
 * Stage-level session headers: providers vary per stage (observer →
 * opencode-go, reflector → openrouter) and across fallback-resolution retries,
 * all under the SAME Pi session id. Each stage must attribute headers from
 * its OWN resolved model — never carry another stage/provider's headers over.
 *
 * Drives runObserverStage with a mocked runObserver (pattern from
 * observer-anchor.test.ts) and captures the agent args per resolved provider.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

import { Runtime } from "../src/om/runtime.js";
import { runObserverStage, type ConsolidationCtx } from "../src/om/consolidation.js";
import type { Entry } from "@earendil-works/pi-ai";

const runObserverSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/om/agents/observer/agent.js", () => ({
  runObserver: runObserverSpy,
}));

function messageEntry(id: string, text: string): Entry {
  return {
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as Entry;
}

const SESSION_ID = "test-session";

function ctxWith(entries: Entry[]): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: false,
    ui: undefined,
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => SESSION_ID,
    },
  } as unknown as ConsolidationCtx;
}

function makeRuntime(): Runtime {
  const runtime = new Runtime();
  runtime.config.memory = true;
  runtime.config.compaction = undefined;
  runtime.config.compactionEngine = undefined;
  runtime.config.observeAfterTokens = 100;
  return runtime;
}

// ~300 estimated tokens per entry, above the 100-token test threshold
const text = (sentinel: string) => `${sentinel} ${"x".repeat(1200)}`;

function resolveModelOk(model: { provider: string; id: string }, headers = {}) {
  return async () => ({
    ok: true as const,
    source: "session" as const,
    model,
    apiKey: "k",
    headers,
  });
}

async function runStage(model: { provider: string; id: string }, headers = {}) {
  const entries = [messageEntry("e1", text("SESSION-CHUNK"))];
  const runtime = makeRuntime();
  const generation = runtime.captureGeneration(SESSION_ID);
  const outcome = await runObserverStage(
    { appendEntry: vi.fn() } as any,
    runtime,
    ctxWith(entries),
    generation,
    resolveModelOk(model, headers),
  );
  expect(outcome).toBe("continue");
  expect(runObserverSpy).toHaveBeenCalledTimes(1);
  return runObserverSpy.mock.calls[0]![0] as {
    headers?: Record<string, string>;
    sessionId?: string;
  };
}

beforeEach(() => {
  runObserverSpy.mockReset();
  runObserverSpy.mockResolvedValue({
    observations: [],
    emptyReason: { kind: "no_new_content" as const },
  });
});

describe("stage session headers follow the stage's own resolved provider", () => {
  test("opencode stage receives the live Pi session id as headers", async () => {
    const arg = await runStage({ provider: "opencode-go", id: "m" }, { "x-existing": "keep" });
    expect(arg.headers).toEqual({
      "x-existing": "keep",
      "x-opencode-session": SESSION_ID,
      "x-opencode-client": "pi",
    });
    expect(arg.sessionId).toBe(SESSION_ID);
  });

  test("openrouter stage under the same session receives no OpenCode headers", async () => {
    const resolvedHeaders = { "x-existing": "keep" };
    const arg = await runStage({ provider: "openrouter", id: "m" }, resolvedHeaders);
    expect("x-opencode-session" in (arg.headers ?? {})).toBe(false);
    expect(arg.headers).toBe(resolvedHeaders);
  });

  test("openrouter stage still threads the session id for future providers", async () => {
    const arg = await runStage({ provider: "openrouter", id: "m" });
    expect(arg.sessionId).toBe(SESSION_ID);
  });
});
