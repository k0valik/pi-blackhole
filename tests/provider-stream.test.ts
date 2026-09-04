import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureRegisteredProviderStreams,
  createBridgeStreamFn,
  createProviderFetch,
  providerStreamKey,
} from "../src/om/provider-stream.js";

const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");
const originalDispatcher = (globalThis as any)[dispatcherSymbol];

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
