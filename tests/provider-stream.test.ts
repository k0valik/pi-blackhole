import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureRegisteredProviderStreams,
  createAttributionTransform,
  createBridgeStreamFn,
  createProviderFetch,
  getOpenCodeSessionHeaders,
  isOpenCodeModel,
  matchesProviderHost,
  providerStreamKey,
  withProviderAttributionHeaders,
} from "../src/om/provider-stream.js";

const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");
const originalDispatcher = (globalThis as any)[dispatcherSymbol];

// PR #95 contract — kept as behavioral equivalence proof. The contributor
// verified these inputs/outputs against a live OpenCode Go gateway (400
// MissingSessionID without headers). Retargeted at the generic choke point:
// identical inputs must produce identical outputs to the fork's heuristic.
describe("OpenCode session headers", () => {
  it("adds stable session headers for OpenCode providers", () => {
    expect(
      withProviderAttributionHeaders(
        { provider: "opencode-go" },
        { "x-existing": "keep" },
        "session-123",
      ),
    ).toEqual({
      "x-existing": "keep",
      "x-opencode-session": "session-123",
      "x-opencode-client": "pi",
    });
  });

  it("does not add OpenCode headers to unrelated providers", () => {
    const headers = { "x-existing": "keep" };
    expect(withProviderAttributionHeaders({ provider: "openrouter" }, headers, "session-123")).toBe(
      headers,
    );
  });
});

describe("provider attribution (generic choke point)", () => {
  it("matches OpenCode by credential-resolved endpoint, not just provider id", () => {
    expect(
      withProviderAttributionHeaders(
        { provider: "custom-proxy", baseUrl: "https://opencode.ai/api" },
        undefined,
        "s-1",
      ),
    ).toEqual({ "x-opencode-session": "s-1", "x-opencode-client": "pi" });
  });

  it("rejects lookalike hosts (exact-hostname parity with pi core)", () => {
    const headers = { "x-existing": "keep" };
    expect(
      withProviderAttributionHeaders(
        { provider: "custom-proxy", baseUrl: "https://evilopencode.ai.evil.com/x" },
        headers,
        "s-1",
      ),
    ).toBe(headers);
  });

  it("treats malformed endpoints as non-OpenCode instead of throwing", () => {
    const headers = { "x-existing": "keep" };
    expect(
      withProviderAttributionHeaders(
        { provider: "custom-proxy", baseUrl: "not a url" },
        headers,
        "s-1",
      ),
    ).toBe(headers);
  });

  it("returns base headers untouched when the session id is missing", () => {
    const headers = { "x-existing": "keep" };
    expect(withProviderAttributionHeaders({ provider: "opencode-go" }, headers, undefined)).toBe(
      headers,
    );
  });

  it("returns base headers untouched for a null model", () => {
    const headers = { "x-existing": "keep" };
    expect(withProviderAttributionHeaders(null, headers, "s-1")).toBe(headers);
  });

  it("preserves a caller-supplied session value (pi-core parity: caller wins)", () => {
    // Mirrors pi core `mergeProviderAttributionHeaders`, which applies caller
    // `headerSources` last. In practice auth-resolved base headers never carry
    // a session id, so the piles never collide — this just pins the order.
    expect(
      withProviderAttributionHeaders(
        { provider: "opencode" },
        { "x-existing": "keep", "x-opencode-session": "caller-value" },
        "current",
      ),
    ).toEqual({
      "x-existing": "keep",
      "x-opencode-session": "caller-value",
      "x-opencode-client": "pi",
    });
  });

  it("never mutates the base headers (fallback chain reuses resolved objects)", () => {
    const base = { "x-existing": "keep", "x-opencode-session": "stale" };
    const snapshot = { ...base };
    withProviderAttributionHeaders({ provider: "opencode-go" }, base, "current");
    expect(base).toEqual(snapshot);
    withProviderAttributionHeaders({ provider: "openrouter" }, base, "current");
    expect(base).toEqual(snapshot);
  });

  it("getOpenCodeSessionHeaders is pure: undefined unless OpenCode + session", () => {
    expect(getOpenCodeSessionHeaders({ provider: "openrouter" }, "s")).toBeUndefined();
    expect(getOpenCodeSessionHeaders({ provider: "opencode-go" }, undefined)).toBeUndefined();
    expect(getOpenCodeSessionHeaders({ provider: "opencode" }, "s")).toEqual({
      "x-opencode-session": "s",
      "x-opencode-client": "pi",
    });
  });

  it("isOpenCodeModel matches ids and exact hosts only", () => {
    expect(isOpenCodeModel({ provider: "opencode" })).toBe(true);
    expect(isOpenCodeModel({ provider: "opencode-go" })).toBe(true);
    expect(isOpenCodeModel({ provider: "other", baseUrl: "https://opencode.ai/v1" })).toBe(true);
    expect(isOpenCodeModel({ provider: "other", baseUrl: "https://xopencode.ai/" })).toBe(false);
    expect(isOpenCodeModel({ provider: "openrouter" })).toBe(false);
    expect(isOpenCodeModel(null)).toBe(false);
    expect(isOpenCodeModel(undefined)).toBe(false);
  });

  it("matchesProviderHost is exact and case-insensitive", () => {
    expect(matchesProviderHost("https://opencode.ai/api", "opencode.ai")).toBe(true);
    expect(matchesProviderHost("https://OpenCode.AI/api", "opencode.ai")).toBe(true);
    expect(matchesProviderHost("https://api.opencode.ai/", "opencode.ai")).toBe(false);
    expect(matchesProviderHost("https://evilopencode.ai.evil.com/", "opencode.ai")).toBe(false);
    expect(matchesProviderHost("not a url", "opencode.ai")).toBe(false);
    expect(matchesProviderHost(undefined, "opencode.ai")).toBe(false);
    expect(matchesProviderHost("", "opencode.ai")).toBe(false);
  });
});

describe("attribution transform composer", () => {
  it("applies attribution after the auth merge", async () => {
    const transform = createAttributionTransform({ provider: "opencode-go" }, "s-1");
    await expect(transform({ Authorization: "Bearer x" })).resolves.toEqual({
      Authorization: "Bearer x",
      "x-opencode-session": "s-1",
      "x-opencode-client": "pi",
    });
  });

  it("chains the caller transform with attributed headers as input", async () => {
    const seen: Array<Record<string, string>> = [];
    const next = vi.fn(async (headers: Record<string, string>) => ({
      ...headers,
      "x-next": "yes",
    }));
    const transform = createAttributionTransform({ provider: "opencode-go" }, "s-1", next);
    const result = await transform({});
    expect(next).toHaveBeenCalledOnce();
    seen.push(next.mock.calls[0]![0] as Record<string, string>);
    expect(seen[0]).toEqual({ "x-opencode-session": "s-1", "x-opencode-client": "pi" });
    expect(result).toEqual({
      "x-opencode-session": "s-1",
      "x-opencode-client": "pi",
      "x-next": "yes",
    });
  });

  it("is a no-op for unrelated providers", async () => {
    const transform = createAttributionTransform({ provider: "openrouter" }, "s-1");
    await expect(transform({ "x-existing": "keep" })).resolves.toEqual({
      "x-existing": "keep",
    });
  });
});

describe("custom provider stream bridge", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-blackhole:provider-streams")];
    vi.unstubAllGlobals();
    if (originalDispatcher === undefined) {
      delete (globalThis as any)[dispatcherSymbol];
    } else {
      (globalThis as any)[dispatcherSymbol] = originalDispatcher;
    }
  });

  it("discovers custom streams through the public model registry API", () => {
    const customStream = vi.fn();
    const registry = {
      getRegisteredProviderIds: () => ["custom-provider"],
      getRegisteredProviderConfig: (providerId: string) =>
        providerId === "custom-provider"
          ? { api: "custom-api", streamSimple: customStream }
          : undefined,
    };
    const providerStreams = new Map<string, Function>();

    captureRegisteredProviderStreams(registry as any, providerStreams);

    expect(providerStreams.get(providerStreamKey("custom-provider", "custom-api"))).toBe(
      customStream,
    );
  });

  it("keeps separate streams for providers that share the same api", () => {
    // Real-world collision: `anthropic` (OAuth/attribution adapter) and
    // `databricks` (bearer-auth gateway) both declare api "anthropic-messages".
    const anthropicStream = vi.fn();
    const databricksStream = vi.fn();
    const configs: Record<string, { api: string; streamSimple: Function }> = {
      anthropic: { api: "anthropic-messages", streamSimple: anthropicStream },
      databricks: { api: "anthropic-messages", streamSimple: databricksStream },
    };
    const registry = {
      getRegisteredProviderIds: () => Object.keys(configs),
      getRegisteredProviderConfig: (id: string) => configs[id],
    };
    const providerStreams = new Map<string, Function>();

    captureRegisteredProviderStreams(registry as any, providerStreams);

    expect(providerStreams.get(providerStreamKey("anthropic", "anthropic-messages"))).toBe(
      anthropicStream,
    );
    expect(providerStreams.get(providerStreamKey("databricks", "anthropic-messages"))).toBe(
      databricksStream,
    );
  });

  it("refreshes a provider's stream when it re-registers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const make = (streamSimple: Function) => ({
      getRegisteredProviderIds: () => ["p"],
      getRegisteredProviderConfig: () => ({ api: "a", streamSimple }),
    });
    const providerStreams = new Map<string, Function>();

    captureRegisteredProviderStreams(make(first) as any, providerStreams);
    captureRegisteredProviderStreams(make(second) as any, providerStreams);

    expect(providerStreams.get(providerStreamKey("p", "a"))).toBe(second);
  });

  it("uses the discovered stream for a custom provider/api pair", () => {
    const fallbackStream = vi.fn();
    const customStream = vi.fn(() => "custom-result");
    const key = Symbol.for("pi-blackhole:provider-streams");
    (globalThis as any)[key] = new Map([
      [providerStreamKey("custom-provider", "custom-api"), customStream],
    ]);
    const bridge = createBridgeStreamFn(fallbackStream);

    expect(bridge({ provider: "custom-provider", api: "custom-api" }, "context", {})).toBe(
      "custom-result",
    );
    expect(customStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("routes a model to its own provider's stream, not another provider with the same api", () => {
    const fallbackStream = vi.fn();
    const anthropicStream = vi.fn(() => "anthropic");
    const databricksStream = vi.fn(() => "databricks");
    const key = Symbol.for("pi-blackhole:provider-streams");
    (globalThis as any)[key] = new Map([
      [providerStreamKey("anthropic", "anthropic-messages"), anthropicStream],
      [providerStreamKey("databricks", "anthropic-messages"), databricksStream],
    ]);
    const bridge = createBridgeStreamFn(fallbackStream);

    expect(bridge({ provider: "databricks", api: "anthropic-messages" }, "ctx", {})).toBe(
      "databricks",
    );
    expect(anthropicStream).not.toHaveBeenCalled();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("uses modelRegistry.streamSimple when the global map has no match", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const registryStream = vi.fn(() => "registry");
    const modelRegistry = {
      streamSimple: registryStream,
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // No global map entry — should use registry.streamSimple
    expect(bridge({ provider: "cursor", api: "cursor-sdk" }, "ctx", {})).toBe("registry");
    expect(registryStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("iterates modelRegistry.getRegisteredProviderConfig to find matching model.api", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const cursorStream = vi.fn(() => "cursor");
    const openaiStream = vi.fn(() => "openai");
    const modelRegistry = {
      getRegisteredProviderIds: () => ["openai", "cursor"],
      getRegisteredProviderConfig: (id: string) => {
        if (id === "openai") return { api: "openai-completions", streamSimple: openaiStream };
        if (id === "cursor") return { api: "cursor-sdk", streamSimple: cursorStream };
        return undefined;
      },
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // Model with cursor-sdk api should find cursorStream
    expect(bridge({ provider: "cursor", api: "cursor-sdk" }, "ctx", {})).toBe("cursor");
    expect(cursorStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("prefers registry.streamSimple over getRegisteredProviderConfig iteration", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const registryStream = vi.fn(() => "registry");
    const matchingStream = vi.fn(() => "matching");
    const modelRegistry = {
      streamSimple: registryStream,
      getRegisteredProviderIds: () => ["cursor"],
      getRegisteredProviderConfig: () => ({ api: "cursor-sdk", streamSimple: matchingStream }),
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // registry.streamSimple takes precedence
    expect(bridge({ provider: "cursor", api: "cursor-sdk" }, "ctx", {})).toBe("registry");
    expect(registryStream).toHaveBeenCalledOnce();
    expect(matchingStream).not.toHaveBeenCalled();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("prefers the model's own provider when several registered providers share an api", () => {
    // Same collision shape as the global-map test above: anthropic and
    // databricks both declare api "anthropic-messages". The registry iteration
    // must not let the first-registered provider hijack the model's stream.
    const fallbackStream = vi.fn(() => "fallback");
    const anthropicStream = vi.fn(() => "anthropic");
    const databricksStream = vi.fn(() => "databricks");
    const configs: Record<string, { api: string; streamSimple: Function }> = {
      anthropic: { api: "anthropic-messages", streamSimple: anthropicStream },
      databricks: { api: "anthropic-messages", streamSimple: databricksStream },
    };
    const modelRegistry = {
      getRegisteredProviderIds: () => Object.keys(configs),
      getRegisteredProviderConfig: (id: string) => configs[id],
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    expect(bridge({ provider: "databricks", api: "anthropic-messages" }, "ctx", {})).toBe(
      "databricks",
    );
    expect(anthropicStream).not.toHaveBeenCalled();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("falls back to api-only matching when no registered provider matches model.provider", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const cursorStream = vi.fn(() => "cursor");
    const modelRegistry = {
      getRegisteredProviderIds: () => ["cursor"],
      getRegisteredProviderConfig: () => ({ api: "cursor-sdk", streamSimple: cursorStream }),
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // Provider id differs from the registered id (e.g. host alias) — api match applies.
    expect(bridge({ provider: "cursor-alias", api: "cursor-sdk" }, "ctx", {})).toBe("cursor");
    expect(cursorStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("falls back to compat when registry lookup throws", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const modelRegistry = {
      getRegisteredProviderIds: () => {
        throw new Error("no runtime");
      },
      getRegisteredProviderConfig: () => undefined,
    };
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // Registry throws — should fall back to compat
    expect(bridge({ provider: "cursor", api: "cursor-sdk" }, "ctx", {})).toBe("fallback");
    expect(fallbackStream).toHaveBeenCalledOnce();
  });

  it("falls back to compat when registry has no streamSimple or provider methods", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const modelRegistry = {};
    const bridge = createBridgeStreamFn(fallbackStream, modelRegistry);

    // Empty registry — should fall back to compat
    expect(bridge({ provider: "cursor", api: "cursor-sdk" }, "ctx", {})).toBe("fallback");
    expect(fallbackStream).toHaveBeenCalledOnce();
  });

  it("falls back to the default stream for a provider without a custom stream", () => {
    const fallbackStream = vi.fn(() => "fallback");
    const anthropicStream = vi.fn();
    const key = Symbol.for("pi-blackhole:provider-streams");
    (globalThis as any)[key] = new Map([
      [providerStreamKey("anthropic", "anthropic-messages"), anthropicStream],
    ]);
    const bridge = createBridgeStreamFn(fallbackStream);

    // Built-in provider speaking the same api must not be hijacked either.
    expect(bridge({ provider: "other", api: "anthropic-messages" }, "ctx", {})).toBe("fallback");
    expect(anthropicStream).not.toHaveBeenCalled();
  });

  it("returns undefined when no timeout is configured (inherit pi default)", async () => {
    const fetchFn = createProviderFetch();
    expect(fetchFn).toBeUndefined();
  });

  it("returns undefined for timeout 0 (explicitly disabled)", async () => {
    const fetchFn = createProviderFetch(0);
    expect(fetchFn).toBeUndefined();
  });

  it("wraps fetch with an explicit positive timeout", async () => {
    const dispatch = vi.fn(() => true);
    (globalThis as any)[dispatcherSymbol] = { dispatch };
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    const wrapped = createProviderFetch(120_000)!;
    await wrapped("https://example.com");
    const requestDispatcher = fetchMock.mock.calls[0]?.[1]?.dispatcher;
    requestDispatcher.dispatch({ path: "/explicit" }, "handler");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      { path: "/explicit", bodyTimeout: 120_000 },
      "handler",
    );
    expect((globalThis as any)[dispatcherSymbol]).toEqual({ dispatch });
  });

  it("chains through a caller-provided dispatcher instead of overwriting it", async () => {
    const outerDispatch = vi.fn(() => true);
    const innerDispatch = vi.fn(() => true);
    const callerDispatcher = { dispatch: outerDispatch };
    (globalThis as any)[dispatcherSymbol] = { dispatch: innerDispatch };
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    const wrapped = createProviderFetch(120_000)!;
    await wrapped("https://example.com", { dispatcher: callerDispatcher });
    const requestDispatcher = fetchMock.mock.calls[0]?.[1]?.dispatcher;
    requestDispatcher.dispatch({ path: "/chained" }, "handler");

    // Caller's dispatcher is used; our timeout is injected into its options.
    expect(outerDispatch).toHaveBeenCalledOnce();
    expect(outerDispatch).toHaveBeenNthCalledWith(
      1,
      { path: "/chained", bodyTimeout: 120_000 },
      "handler",
    );
    expect(innerDispatch).not.toHaveBeenCalled();
  });
});

describe("bridge session attribution (generic, no per-provider branching)", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-blackhole:provider-streams")];
  });

  function captureFallback() {
    const seen: Array<{ model: any; opts: any }> = [];
    const fallback = vi.fn((model: any, _ctx: any, opts: any) => {
      seen.push({ model, opts });
      return "fallback-result";
    });
    return { fallback, seen };
  }

  it("pre-merges session headers for OpenCode models from opts.sessionId", () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const result = bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", {
      headers: { "x-existing": "keep" },
      sessionId: "sess-1",
    });
    expect(result).toBe("fallback-result");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts.headers).toEqual({
      "x-existing": "keep",
      "x-opencode-session": "sess-1",
      "x-opencode-client": "pi",
    });
  });

  it("installs a transformHeaders honored at pi's auth-merge layer", async () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", {
      headers: { "x-existing": "keep" },
      sessionId: "sess-1",
    });
    const transform = seen[0]!.opts.transformHeaders;
    expect(typeof transform).toBe("function");
    // pi-ai applyAuth calls transformHeaders(mergedAuthHeaders) after merging
    // auth headers — attribution must survive that layer too.
    await expect(transform({ Authorization: "Bearer auth" })).resolves.toEqual({
      Authorization: "Bearer auth",
      "x-opencode-session": "sess-1",
      "x-opencode-client": "pi",
    });
  });

  it("passes unrelated providers through untouched", () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const opts = { headers: { "x-existing": "keep" }, sessionId: "sess-1" };
    expect(bridge({ provider: "openrouter", api: "openai-completions" }, "ctx", opts)).toBe(
      "fallback-result",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts).toBe(opts);
  });

  it("passes requests without a session id through untouched", () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const opts = { headers: { "x-existing": "keep" } };
    expect(bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", opts)).toBe(
      "fallback-result",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts).toBe(opts);
  });

  it("attributes custom-registered streams, not just compat", () => {
    const seen: Array<any> = [];
    const customStream = vi.fn((_model: any, _ctx: any, opts: any) => {
      seen.push(opts);
      return "custom-result";
    });
    const key = Symbol.for("pi-blackhole:provider-streams");
    (globalThis as any)[key] = new Map([
      [providerStreamKey("opencode-go", "anthropic-messages"), customStream],
    ]);
    const bridge = createBridgeStreamFn(vi.fn());
    expect(
      bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", {
        sessionId: "sess-7",
      }),
    ).toBe("custom-result");
    expect(seen).toHaveLength(1);
    expect(seen[0].headers).toEqual({
      "x-opencode-session": "sess-7",
      "x-opencode-client": "pi",
    });
  });

  it("chains a caller transformHeaders after attribution", async () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const incoming = vi.fn(async (headers: Record<string, string>) => ({
      ...headers,
      "x-caller": "yes",
    }));
    bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", {
      sessionId: "sess-1",
      transformHeaders: incoming,
    });
    const transform = seen[0]!.opts.transformHeaders;
    const result = await transform({});
    expect(incoming).toHaveBeenCalledOnce();
    expect(incoming.mock.calls[0]![0]).toEqual({
      "x-opencode-session": "sess-1",
      "x-opencode-client": "pi",
    });
    expect(result).toEqual({
      "x-opencode-session": "sess-1",
      "x-opencode-client": "pi",
      "x-caller": "yes",
    });
  });

  it("never carries attribution across providers sharing one session", () => {
    // Stages resolve different providers (observer → opencode-go, reflector →
    // openrouter) under the SAME Pi session id. Attribution is derived per
    // call from that call's model — the openrouter call must be untouched.
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", {
      headers: { "x-existing": "keep" },
      sessionId: "same-session",
    });
    const openrouterOpts = { headers: { "x-existing": "keep" }, sessionId: "same-session" };
    bridge({ provider: "openrouter", api: "openai-completions" }, "ctx", openrouterOpts);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.opts.headers["x-opencode-session"]).toBe("same-session");
    expect(seen[1]!.opts).toBe(openrouterOpts);
    expect(seen[1]!.opts.headers).toEqual({ "x-existing": "keep" });
  });

  it("derives attribution from each call's session, never a cached one", () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const model = { provider: "opencode-go", api: "anthropic-messages" };
    bridge(model, "ctx", { sessionId: "first" });
    bridge(model, "ctx", { sessionId: "second" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.opts.headers["x-opencode-session"]).toBe("first");
    expect(seen[1]!.opts.headers["x-opencode-session"]).toBe("second");
  });

  it("never mutates the caller's opts object", () => {
    const { fallback, seen } = captureFallback();
    const bridge = createBridgeStreamFn(fallback);
    const opts = { headers: { "x-existing": "keep" }, sessionId: "sess-1" };
    const snapshot = JSON.parse(JSON.stringify(opts));
    bridge({ provider: "opencode-go", api: "anthropic-messages" }, "ctx", opts);
    expect(opts).toEqual(snapshot);
    expect(seen[0]!.opts).not.toBe(opts);
  });
});
