import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import { flushDebugLog, withDebugLogContext } from "../src/om/debug-log.js";
const host = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => host.dir,
}));
const identity = { provider: "probe", id: "compactor" };
function events() {
  flushDebugLog();
  const path = join(host.dir, "pi-blackhole/debug.ndjson");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((e) => e.event === "model.cooldown_write")
    : [];
}
beforeEach(() => {
  host.dir = mkdtempSync(join(tmpdir(), "blackhole-cooldown-log-"));
});
afterEach(() => {
  flushDebugLog();
  rmSync(host.dir, { recursive: true, force: true });
});
describe("cooldown write diagnostics", () => {
  test.each([
    ["HTTP 401 Unauthorized", "provider_configuration"],
    ["HTTP 404 model not found", "provider_configuration"],
    ["HTTP 503 Service Unavailable", "provider_transient"],
    ["ECONNRESET", "provider_transient"],
    ["unclassified failure", "unknown"],
  ])("records one classified event for %s", (message, causeClass) => {
    const runtime = new Runtime(host.dir);
    withDebugLogContext({ enabled: true }, () =>
      runtime.recordRetryableError(identity, new Error(message), "observer"),
    );
    expect(events()).toEqual([
      expect.objectContaining({
        data: {
          model: "probe/compactor",
          stage: "observer",
          causeClass,
          reason: message,
        },
      }),
    ]);
    const persisted = JSON.parse(
      readFileSync(join(host.dir, "pi-blackhole/pi-blackhole-cooldown.json"), "utf8"),
    );
    expect(persisted["probe/compactor"].reason).toBe(message);
  });
  test("session writer logs once with a sanitized reason, not a response body", () => {
    const runtime = new Runtime(host.dir);
    withDebugLogContext({ enabled: true }, () =>
      runtime.recordDeterministicError(
        identity,
        new Error('HTTP 401 Unauthorized {"secret":"do-not-log"}'),
        "reflector",
      ),
    );
    expect(events()).toEqual([
      expect.objectContaining({
        data: {
          model: "probe/compactor",
          stage: "reflector",
          causeClass: "provider_configuration",
          reason: "HTTP 401 Unauthorized",
        },
      }),
    ]);
  });
  test("HTML error bodies never enter the write event", () => {
    const runtime = new Runtime(host.dir);
    withDebugLogContext({ enabled: true }, () =>
      runtime.recordRetryableError(
        identity,
        new Error("HTTP 503 Unavailable <html><body>private provider response</body></html>"),
        "dropper",
      ),
    );
    expect(events()[0]?.data.reason).toBe("HTTP 503 Unavailable");
  });
  test("disabled debug logging produces no event", () => {
    const runtime = new Runtime(host.dir);
    runtime.recordRetryableError(identity, new Error("HTTP 503 Unavailable"), "observer");
    expect(events()).toEqual([]);
  });
  test("zero-hour cooldown does not claim a write", () => {
    const runtime = new Runtime(host.dir);
    withDebugLogContext({ enabled: true }, () =>
      runtime.recordRetryableError(
        { ...identity, cooldownHours: 0 },
        new Error("HTTP 503 Unavailable"),
        "observer",
      ),
    );
    expect(events()).toEqual([]);
  });
  test("failed persistence does not claim a successful write", () => {
    // Block only cooldown persistence: debug.ndjson must remain writable or
    // this negative assertion would pass even if a write event were emitted.
    mkdirSync(join(host.dir, "pi-blackhole/pi-blackhole-cooldown.json"), { recursive: true });
    const runtime = new Runtime(host.dir);
    withDebugLogContext({ enabled: true }, () =>
      runtime.recordRetryableError(identity, new Error("HTTP 503 Unavailable"), "observer"),
    );
    expect(events()).toEqual([]);
  });
});
