/**
 * Issue #80: cooldown reason sanitizer misses HTML error bodies.
 *
 * recordRetryableError must persist only a short status line (≤200 chars),
 * never a full HTML WAF page — and the skip toast must not inline the reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-cooldown-sanitize-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250,
}));

function writeConfig(data: unknown): void {
  mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
  writeFileSync(
    join(testDir, "pi-blackhole", "pi-blackhole-config.json"),
    JSON.stringify(data, null, 2),
  );
}

function readCooldownFile(): Record<string, { reason: string; until: string; stage: string }> {
  const p = join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function makeModel(id: string, provider = "openrouter") {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function makeRegistry(models: ReturnType<typeof makeModel>[]) {
  return {
    models,
    find: vi.fn((p: string, id: string) => models.find((m) => m.provider === p && m.id === id)),
    hasConfiguredAuth: vi.fn(() => true),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "sk-test" })),
  };
}

const HTML_PAGE =
  `<!DOCTYPE html><html><head><style>@font-face{font-family:x;` +
  `src:url(data:font/woff2;base64,${"A".repeat(2000)})}</style></head>` +
  `<body>Blocked by WAF ${"y".repeat(2000)}</body></html>`;

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("sanitizeCooldownReason", () => {
  it("reduces an HTTP 403 + HTML page to a short HTTP status line", async () => {
    const { sanitizeCooldownReason } = await import("../src/om/cooldown.js");
    const out = sanitizeCooldownReason(`HTTP 403 Forbidden ${HTML_PAGE}`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/^HTTP 403/);
    expect(out).not.toContain("<!DOCTYPE");
    expect(out).not.toContain("@font-face");
  });

  it("reduces a prefix-less HTML page with a status code to HTTP <status>", async () => {
    const { sanitizeCooldownReason } = await import("../src/om/cooldown.js");
    const out = sanitizeCooldownReason(`${HTML_PAGE} error 503 tail`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toContain("<!DOCTYPE");
    expect(out).toMatch(/^HTTP \d{3}/);
  });

  it("falls back to a generic marker for HTML with no status code", async () => {
    const { sanitizeCooldownReason } = await import("../src/om/cooldown.js");
    const out = sanitizeCooldownReason("<!DOCTYPE html><html><body>blocked</body></html>");
    expect(out).toBe("HTTP error (HTML body omitted)");
  });

  it("still strips a trailing {json} body", async () => {
    const { sanitizeCooldownReason } = await import("../src/om/cooldown.js");
    expect(sanitizeCooldownReason('429 Too Many Requests {"error":{"message":"slow down"}}')).toBe(
      "429 Too Many Requests",
    );
  });

  it("caps a long non-HTML reason at 200 chars", async () => {
    const { sanitizeCooldownReason } = await import("../src/om/cooldown.js");
    const out = sanitizeCooldownReason(`upstream error ${"z".repeat(500)}`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("recordRetryableError with HTML body (issue #80)", () => {
  it("persists a short status line, not the HTML page", async () => {
    writeConfig({});
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    runtime.recordRetryableError(
      { provider: "openrouter", id: "html:free", cooldownHours: 1 },
      new Error(`HTTP 403 Forbidden ${HTML_PAGE}`),
      "observer",
    );

    const data = readCooldownFile();
    const reason: string = data["openrouter/html:free"].reason;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).not.toContain("<!DOCTYPE");
    expect(reason).not.toContain("@font-face");
    expect(reason).toMatch(/^HTTP 403/);
  });

  it("recordCooldown sanitizes even when called with a raw HTML body", async () => {
    writeConfig({});
    const { recordCooldown } = await import("../src/om/cooldown.js");
    recordCooldown(
      { provider: "openrouter", id: "direct:free", cooldownHours: 1 },
      `HTTP 503 Unavailable ${HTML_PAGE}`,
      "reflector",
    );
    const reason: string = readCooldownFile()["openrouter/direct:free"].reason;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).not.toContain("<!DOCTYPE");
  });
});

describe("resolveModel skip toast (issue #80)", () => {
  it("does not dump the cooldown reason body into the toast", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "toast:free", cooldownHours: 1 },
    });
    // Simulate a pre-fix cooldown file holding an unsanitized HTML reason.
    mkdirSync(join(testDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json"),
      JSON.stringify({
        "openrouter/toast:free": {
          until: new Date(Date.now() + 3600_000).toISOString(),
          reason: `HTTP 403 Forbidden ${HTML_PAGE}`,
          stage: "observer",
        },
      }),
    );

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.consolidationPhase = "observer";

    const notify = vi.fn();
    const registry = makeRegistry([makeModel("toast:free")]);
    await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: true,
      ui: { notify },
      stageModel: { provider: "openrouter", id: "toast:free" },
      stageFallbacks: [],
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const toast: string = notify.mock.calls[0][0];
    expect(toast).not.toContain("<!DOCTYPE");
    expect(toast).not.toContain("@font-face");
    expect(toast).toContain("details in cooldown log");
  });
});
