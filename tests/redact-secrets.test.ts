import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/core/summarize.js";
import { redactSecrets } from "../src/core/redact-secrets.js";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import { projectAppendOnlyContext } from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";

// Synthetic values shaped like keys users paste into chat; none are real credentials.
// Prefixes are concatenated so secret scanners do not flag this file.
const HEX64 = "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a";
const OPENROUTER = "sk-" + `or-v1-${HEX64}`;
const VENDOR_PREFIX = "classifier" + `_live_${HEX64}`;
const KAGGLE = "KGAT" + "_4b8e2a6c9d1f3e5a7b0c2d4e6f8a1b3c";

const msg = (id: string, role: "user" | "assistant", content: string) => ({
  id,
  type: "message",
  timestamp: "2026-10-04T00:00:00.000Z",
  message: { role, content, timestamp: 1 },
});

describe("redactSecrets", () => {
  it.each([
    `${OPENROUTER} here is my openrouter apikey for the eval`,
    `try this one, APIKEY, ${VENDOR_PREFIX} docs at https://example.com/docs`,
    `switch the API to this one, ${VENDOR_PREFIX}`,
    `${KAGGLE}, my kaggle api key`,
    "export OPENAI_API_KEY=a8F3kL9qZ2xV7mN4pR6tW1yB5cD0eG",
    `api_key = "${HEX64}"`,
    "db password: Xk82mQp4Lz9RtV3nWc7Y",
    "postgres://admin:hunter2pass@db.local:5432/app",
    // Vendor formats whose random body happens to contain no digits.
    "AKIA" + "QWERTYUIOPASDFGH is the access key",
    "hf" + "_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh",
  ])("masks %s", (text) => {
    const out = redactSecrets(text);
    expect(out).toMatch(/\[REDACTED [a-z-]+\]/);
    expect(out).not.toMatch(/[0-9a-f]{32}|a8F3kL9q|Xk82mQp4|hunter2pass|QWERTYUIOP|AbCdEfGhIj/);
  });

  it.each([
    `commit ${HEX64.slice(0, 40)} fixed the auth bug`,
    `api key image sha256:${HEX64}`,
    "token budget: observationsPoolMaxTokens=20000",
    "session 01a0e9a6-e186-731f-9872-6f773791d998 used anthropic/claude-sonnet-4-5",
    "node_id: C_kwDOAbCdEf12GhIjKlMnOpQrStUvWx34 author token",
    "Next Page Token = CfDJ8AbCdEfGhIjKlMnOpQrStUv12345",
    "read /home/u/.pi/agent/sessions/2026-09-28T20-13-43-175Z_01a0e9a6-e186.jsonl for auth",
    "api: normalizeSourceAddressedBranchEntries2 handles token windows",
    "use sk-learn-compatible-estimators for the token classifier",
  ])("keeps %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("credential redaction at derived-context boundaries", () => {
  it("compile() masks a pasted key and keeps the surrounding request", () => {
    const summary = compile({
      messages: [
        {
          role: "user",
          content: `${OPENROUTER} this is my apikey, please measure latency with the official model`,
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "OK, starting the test." }],
          timestamp: 2,
        },
      ] as any,
    });
    expect(summary).not.toContain(HEX64);
    expect(summary).toContain("[REDACTED api-key]");
    expect(summary).toContain("please measure latency");
  });

  it("compile() masks a key inherited from the previous summary", () => {
    const summary = compile({
      messages: [{ role: "user", content: "continue the latency test", timestamp: 1 }] as any,
      previousSummary: `[Session Goal]\n- ${OPENROUTER} use this apikey for the eval`,
    });
    expect(summary).not.toContain(HEX64);
  });

  it("the observer chunk never carries the key", () => {
    const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([
      msg("u1", "user", `switch the API to this one, ${VENDOR_PREFIX}`),
    ]);
    expect(sourceEntryIds).toEqual(["u1"]);
    expect(text).not.toContain(HEX64);
    expect(text).toContain("switch the API to this one");
  });

  const compact = (config: Record<string, unknown>, branchEntries: any[]) => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    const runtime = {
      ensureConfig: vi.fn(),
      config: {
        compaction: "auto",
        compactionEngine: "blackhole",
        tailBehavior: "minimal",
        midRunCompaction: "off",
        skipForProviders: [],
        memory: false,
        debug: false,
        debugLog: false,
        observationsPoolMaxTokens: 20_000,
        retainedToolOutputMaxTokens: 20_000,
        reflectionsPoolMaxTokens: 8_000,
        fullFoldAlways: true,
        ...config,
      },
      compactWasPiVcc: false,
      compactionStats: null,
      appendFallbackNotified: false,
    };
    registerBeforeCompactHook(
      { on: (e: string, cb: any) => e === "session_before_compact" && (handler = cb) } as any,
      runtime as any,
    );
    return handler!(
      {
        type: "session_before_compact",
        reason: "threshold",
        branchEntries,
        preparation: {
          fileOps: { read: [], written: [], edited: [] },
          tokensBefore: 1000,
          settings: { reserveTokens: 2000 },
        },
        signal: new AbortController().signal,
      },
      {
        cwd: process.cwd(),
        model: { provider: "anthropic", api: "messages", id: "test" },
        sessionManager: { getEntries: () => branchEntries },
        ui: { notify: vi.fn() },
      },
    ).compaction;
  };
  const conversation = [
    msg("m1", "user", "run the eval"),
    msg("m2", "assistant", "started"),
    msg("m3", "user", "keep tail"),
    msg("m4", "assistant", "tail answer"),
  ];

  it("observations recorded before redaction are masked in the compaction summary", () => {
    const observation = {
      id: "3f9c2a1b8d4e",
      timestamp: "2026-10-04T00:00:00.000Z",
      relevance: "high",
      content: `User provided OpenRouter key ${OPENROUTER} for the eval`,
      sourceEntryIds: ["m1"],
      tokenCount: 30,
    };
    const omEntry = {
      id: "om1",
      type: "custom",
      customType: "om.observations.recorded",
      data: { observations: [observation], coversUpToId: "m1" },
    };
    const { summary } = compact({ memory: true }, [omEntry, ...conversation]);
    expect(summary).toContain("User provided OpenRouter key");
    expect(summary).not.toContain(HEX64);
  });

  it("append mode masks a key frozen in a segment written before redaction", () => {
    const compaction = compact({ compactionSummaryMode: "append" }, conversation);
    expect(isPiVccCompactionDetailsV2(compaction.details)).toBe(true);
    // Simulate a segment frozen by an earlier version that did not redact.
    compaction.details.segment.summary += `\n- ${OPENROUTER} use this apikey`;
    const projected = projectAppendOnlyContext(
      [
        {
          role: "compactionSummary",
          summary: compaction.summary,
          tokensBefore: 1000,
          timestamp: 1,
        },
      ],
      [{ id: "c1", type: "compaction", timestamp: 1, ...compaction }],
    );
    expect(projected.some((m: any) => m.role === "compactionSummary")).toBe(true);
    expect(JSON.stringify(projected)).not.toContain(HEX64);
  });
});
