import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/core/summarize.js";
import { redactSecrets } from "../src/core/redact-secrets.js";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.js";
import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import { projectAppendOnlyContext } from "../src/core/compaction-chain.js";
import { isPiVccCompactionDetailsV2 } from "../src/details.js";
import {
  observationToSummaryLine,
  reflectionToSummaryLine,
} from "../src/om/ledger/render-summary.js";
import {
  buildExistingObservationsSummary,
  buildExistingReflectionsSummary,
} from "../src/om/ledger/progress.js";
import { observationToDropperLine } from "../src/om/agents/dropper/coverage.js";

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
    // `/` inside a URL password or a base64 value.
    "postgres://admin:Xk8sT2pQ/we4rZ@db.local:5432/app",
    "api_key: AbCdEf12/ghIjKl45MnOp67QrSt89",
    "token=Zm9vYmFyL3F1eC9iYXo1MjM0NTY3",
    "postgres://admin:123456789012@db.local/app",
    "api_key: AbCdEf12GhIjKl45MnOp67QrSt8/",
    "api_key: Xk82mQp4/abcd/Lz9RtV3nWc7YbN4p",
    // Label and value on separate lines (pretty-printed JSON, YAML, .env dumps).
    '{\n  "apiKey":\n    "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e"\n}',
    "password:\n  Xk82mQp4Lz9RtV3nWc7YbN4pR6tW1y",
    '"apiKey":\n  "Xk82mQp4/abcd/Lz9RtV3nWc7YbN4p"',
  ])("masks %s", (text) => {
    const out = redactSecrets(text);
    expect(out).toMatch(/\[REDACTED [a-z-]+\]/);
    expect(out).not.toMatch(
      /[0-9a-f]{32}|a8F3kL9q|Xk82mQp4|hunter2pass|QWERTYUIOP|AbCdEfGhIj|Xk8sT2pQ|AbCdEf12|Zm9vYmFy|123456789012/,
    );
    // Summaries are redacted more than once (segment, compile, projection on read).
    expect(redactSecrets(out)).toBe(out);
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
    // A port followed by a query, fragment or path is not a URL password.
    "https://host:8080?email=a@b.com",
    "https://host:8080#x@y",
    "https://host:8080/users/a@b.com",
    "https://example.com/a/b@c",
    // Paths next to a credential keyword stay intact now that `/` is a candidate character.
    "token cache at cache/models/Llama3Instruct8BQuantized/weights",
    "the api lives in src/services/ApiClient2024/handlers",
    "token:\n  /var/lib/app/AbCdEf12GhIjKl34MnOp56",
  ])("keeps %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    // A raw `@` inside the password is part of it; the host and path after the last one are kept.
    ["postgres://admin:pa@ss@db.local/app", "postgres://admin:[REDACTED password]@db.local/app"],
    ["postgres://admin:pa@@ss@db.local/app", "postgres://admin:[REDACTED password]@db.local/app"],
    [
      "https://user:p@ss@host/path?email=a@b.com",
      "https://user:[REDACTED password]@host/path?email=a@b.com",
    ],
    // More digits than a port can have: a password, not `host:port/path`.
    ["redis://svc:20245678/key@cache.internal", "redis://svc:[REDACTED password]@cache.internal"],
  ])("masks only the URL password in %s", (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
    expect(redactSecrets(expected)).toBe(expected);
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
    expect(summary).toContain("[REDACTED api-key]");
    expect(summary).toContain("use this apikey for the eval");
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

  it("memory lines sent to the observer, reflector and dropper mask stored keys", () => {
    // Memories recorded before redaction existed still hold the raw key.
    const observation = {
      id: "3f9c2a1b8d4e",
      timestamp: "2026-10-04T00:00:00.000Z",
      relevance: "high",
      content: `User provided OpenRouter key ${OPENROUTER} for the eval`,
      sourceEntryIds: ["m1"],
      tokenCount: 30,
    } as any;
    const reflection = {
      id: "7a1b2c3d4e5f",
      content: `Eval runs use key ${OPENROUTER}`,
      supportingObservationIds: ["3f9c2a1b8d4e"],
    } as any;
    const lines = [
      observationToSummaryLine(observation),
      reflectionToSummaryLine(reflection),
      buildExistingObservationsSummary([observation], 1000),
      buildExistingReflectionsSummary([reflection], 1000),
      observationToDropperLine(observation, "none"),
    ];
    for (const line of lines) {
      expect(line).not.toContain(HEX64);
      expect(line).toContain("[REDACTED api-key]");
    }
    expect(lines[0]).toContain("User provided OpenRouter key");
    expect(lines[1]).toContain("Eval runs use key");
  });

  it("append mode masks keys frozen in a segment and tail written before redaction", () => {
    const compaction = compact({ compactionSummaryMode: "append" }, conversation);
    expect(isPiVccCompactionDetailsV2(compaction.details)).toBe(true);
    // Simulate a segment and tail frozen by an earlier version that did not redact.
    compaction.details.segment.summary += `\n- ${OPENROUTER} use this apikey`;
    compaction.details.trailingSummary += `\n- tail note ${OPENROUTER} apikey`;
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
    const text = JSON.stringify(projected);
    expect(text).not.toContain(HEX64);
    expect(text).toContain("use this apikey");
    expect(text).toContain("tail note");
  });
});
