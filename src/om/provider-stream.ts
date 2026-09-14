/**
 * Bridge streamSimple to support custom providers via global Symbol.for().
 *
 * When a custom provider is registered (via index.ts at startup), its stream
 * function is stored under a shared global symbol. This module provides the
 * bridge logic so all OM agents (observer, reflector, dropper) use the same
 * custom-provider resolution instead of each duplicating the 15-line function.
 */
interface RegisteredProviderConfig {
  api?: string;
  streamSimple?: Function;
}

interface ProviderRegistry {
  getRegisteredProviderIds?: () => readonly string[];
  getRegisteredProviderConfig?: (providerId: string) => RegisteredProviderConfig | undefined;
  registeredProviders?: Map<string, RegisteredProviderConfig>;
}

/**
 * Duck-typed subset of Pi's extension ModelRegistry that the bridge needs.
 *
 * `streamSimple` is the host-composed path (Pi #8964). Until that lands on the
 * facade, `getRegisteredProviderConfig` still exposes each `registerProvider`
 * `streamSimple` handler, keyed by the extension provider id — match on
 * `providerId === model.provider` first, then on `config.api === model.api`.
 */
export interface ModelRegistry {
  streamSimple?: Function;
  getRegisteredProviderIds?: () => readonly string[];
  getRegisteredProviderConfig?: (providerId: string) => RegisteredProviderConfig | undefined;
}

/**
 * Key custom streams by `${provider}\u0000${api}` — NOT by `api` alone.
 *
 * Several extensions can register different providers that share one wire API
 * (e.g. `anthropic` and `databricks` both declare `api: "anthropic-messages"`).
 * Keying by api alone let the first-registered provider hijack every model that
 * spoke the same protocol, routing Databricks-hosted Claude through the Anthropic
 * transport (wrong URL/auth) and vice versa. Mirror pi core's rule: a custom
 * streamSimple applies only to models of *that* provider whose `model.api`
 * equals the provider's declared `api`.
 */
export function providerStreamKey(provider: string, api: string): string {
  return `${provider}\u0000${api}`;
}

export function captureRegisteredProviderStreams(
  registry: ProviderRegistry,
  providerStreams: Map<string, Function>,
): void {
  if (registry.getRegisteredProviderIds && registry.getRegisteredProviderConfig) {
    for (const providerId of registry.getRegisteredProviderIds()) {
      const config = registry.getRegisteredProviderConfig(providerId);
      if (config?.streamSimple && config.api) {
        // Always overwrite: providers may re-register (e.g. after async model refresh).
        providerStreams.set(providerStreamKey(providerId, config.api), config.streamSimple);
      }
    }
    return;
  }

  registry.registeredProviders?.forEach((config, providerId) => {
    if (config.streamSimple && config.api && typeof providerId === "string") {
      providerStreams.set(providerStreamKey(providerId, config.api), config.streamSimple);
    }
  });
}

/** Pi 0.81 forwards fetch at runtime but omits it from AgentLoopConfig types. */
export type ProviderFetchOption = { fetch?: typeof fetch };

// ── Provider-required request headers (attribution) ────────────────────────────
//
// Pi's interactive path (`sdk.ts` streamFn) applies
// `mergeProviderAttributionHeaders()` + `before_provider_headers` to every
// provider request. OM workers call `streamSimple` directly (pi-ai compat or a
// custom-registered stream), bypassing that pipeline — so correctness-critical
// provider headers must be applied here, at the single choke point all three
// consolidation stages share.
//
// Mirror of pi core `provider-attribution.ts#getSessionHeaders`
// (@earendil-works/pi-coding-agent 0.85.1). A shared import is not possible —
// the package `exports` map blocks `./dist/core/*` subpaths — so this mirrors
// the rule instead of reusing it. Deliberately scoped to session headers
// (correctness): pi's default attribution headers (OpenRouter referrer, Nvidia
// billing origin, Cloudflare UA) are telemetry-only and owned by pi's sdk
// path; duplicating them here would fork non-breaking behavior. Requests
// succeed without them, but OpenCode Go rejects requests without a stable
// `x-opencode-session` (400 MissingSessionID). Re-check against pi core when
// bumping the pi dependency. Future provider rules belong in
// `withProviderAttributionHeaders` — never at the stage call sites.
/** Host pi core attributes OpenCode session headers to (exact match). */
export const OPENCODE_HOST = "opencode.ai";

const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** Exact-hostname match (pi core `matchesHost` parity): rejects `evilopencode.ai.evil.com`. */
export function matchesProviderHost(baseUrl: unknown, expectedHost: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}

/** True for OpenCode providers by id or by credential-resolved endpoint. */
export function isOpenCodeModel(
  model: { provider?: unknown; baseUrl?: unknown } | null | undefined,
): boolean {
  if (!model) return false;
  if (typeof model.provider === "string" && OPENCODE_PROVIDERS.has(model.provider)) return true;
  return matchesProviderHost(model.baseUrl, OPENCODE_HOST);
}

/** Pure OpenCode session headers, or undefined when not applicable. */
export function getOpenCodeSessionHeaders(
  model: { provider?: unknown; baseUrl?: unknown } | null | undefined,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!sessionId || !isOpenCodeModel(model)) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/**
 * Generic choke point: merge provider-required attribution headers under base
 * headers. Add future provider rules here — never at the stage call sites.
 * Merge order is pi-core parity (`mergeProviderAttributionHeaders` applies
 * caller `headerSources` last): caller-supplied headers win over attribution.
 * In practice the two never collide — auth-resolved base headers don't carry
 * session ids — so this matches pi's wire behavior exactly.
 */
export function withProviderAttributionHeaders(
  model: { provider?: unknown; baseUrl?: unknown } | null | undefined,
  headers: Record<string, string> | undefined,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  const attribution = getOpenCodeSessionHeaders(model, sessionId);
  if (!attribution) return headers;
  return { ...attribution, ...headers };
}

/** Minimal `transformHeaders` shape (pi-ai `ModelsRequestTransforms`). */
export type AttributionTransform = (
  headers: Record<string, string>,
) => Record<string, string> | Promise<Record<string, string>>;

/**
 * `transformHeaders`-compatible composer applying attribution after auth merge,
 * then chaining the caller's transform (if any). This is the seam where pi's
 * own `transformHeaders` concept runs — pi-ai's `applyAuth` honors it, so
 * builtin providers get attribution at pi's layer, after auth headers.
 * Idempotent: re-applying the same session's attribution preserves values.
 */
export function createAttributionTransform(
  model: { provider?: unknown; baseUrl?: unknown } | null | undefined,
  sessionId: string | undefined,
  next?: AttributionTransform | null,
): AttributionTransform {
  return async (headers: Record<string, string>) => {
    const attributed = withProviderAttributionHeaders(model, headers, sessionId) ?? {};
    if (typeof next === "function") return (await next(attributed)) ?? attributed;
    return attributed;
  };
}

/**
 * Intentionally minimal duck-type for undici's per-request dispatcher.
 *
 * Current Node/undici only requires `dispatch(options, handler)` on the
 * dispatcher object passed via `RequestInit.dispatcher`. We avoid importing
 * undici types to keep this module version-agnostic across Node releases.
 */
interface Dispatcher {
  dispatch(options: Record<string, unknown>, handler: unknown): unknown;
}

const GLOBAL_DISPATCHER_SYMBOLS = [
  Symbol.for("undici.globalDispatcher.2"),
  Symbol.for("undici.globalDispatcher.1"),
];

function getGlobalDispatcher(): Dispatcher {
  for (const symbol of GLOBAL_DISPATCHER_SYMBOLS) {
    const dispatcher = (globalThis as Record<symbol, unknown>)[symbol];
    if (dispatcher && typeof (dispatcher as Dispatcher).dispatch === "function") {
      return dispatcher as Dispatcher;
    }
  }
  throw new Error("Blackhole provider idle timeout requires Pi's Undici dispatcher");
}

/**
 * Wrap `globalThis.fetch` with a per-request dispatcher that injects `bodyTimeout`.
 *
 * Semantics:
 * - `timeoutMs === undefined` → returns undefined (inherit pi's global default).
 * - `timeoutMs === 0`        → returns undefined (explicitly disabled).
 * - `timeoutMs > 0`          → returns a fetch wrapper that applies `bodyTimeout`.
 *
 * If the caller already supplied an `init.dispatcher`, we chain through it
 * rather than silently overwriting it.
 */
export function createProviderFetch(timeoutMs?: number): typeof fetch | undefined {
  // Unset or explicitly disabled → let pi's global default / caller setup apply.
  if (timeoutMs === undefined || timeoutMs === 0) return undefined;

  const dispatcher: Dispatcher = {
    dispatch(options, handler) {
      return getGlobalDispatcher().dispatch({ ...options, bodyTimeout: timeoutMs }, handler);
    },
  };

  return (input, init) => {
    const callerDispatcher = (init as any)?.dispatcher;
    if (typeof callerDispatcher?.dispatch === "function") {
      // Respect caller-provided dispatcher by chaining our timeout through it.
      const chained: Dispatcher = {
        dispatch(options, handler) {
          return callerDispatcher.dispatch({ ...options, bodyTimeout: timeoutMs }, handler);
        },
      };
      return fetch(input, { ...init, dispatcher: chained } as RequestInit & {
        dispatcher: Dispatcher;
      });
    }
    return fetch(input, { ...init, dispatcher } as RequestInit & {
      dispatcher: Dispatcher;
    });
  };
}

export function createBridgeStreamFn(
  streamSimple: any,
  modelRegistry?: ModelRegistry | null,
): (model: any, ctx: any, opts: any) => any {
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  // Shared dispatch: custom streams first, compat last. `o` carries the
  // (possibly attribution-enriched) request options for this call.
  const dispatch = (model: any, ctx: any, o: any): any => {
    // 1. Check modelRegistry.streamSimple (host-composed facade, Pi #8964)
    if (modelRegistry && typeof (modelRegistry as any).streamSimple === "function") {
      return (modelRegistry as any).streamSimple(model, ctx, o);
    }

    // 2. Iterate getRegisteredProviderConfig: prefer the model's own provider
    //    (several providers can share one api — providerStreamKey rationale),
    //    then fall back to an api-only match for aliased provider ids.
    if (
      modelRegistry &&
      typeof (modelRegistry as any).getRegisteredProviderIds === "function" &&
      typeof (modelRegistry as any).getRegisteredProviderConfig === "function"
    ) {
      try {
        let apiMatch: Function | undefined;
        for (const providerId of (modelRegistry as any).getRegisteredProviderIds()) {
          const config = (modelRegistry as any).getRegisteredProviderConfig(providerId);
          if (!config || typeof config.streamSimple !== "function") continue;
          if (providerId === model.provider && config.api === model.api) {
            return config.streamSimple(model, ctx, o);
          }
          if (config.api === model.api && apiMatch === undefined) {
            apiMatch = config.streamSimple;
          }
        }
        if (apiMatch) return apiMatch(model, ctx, o);
      } catch {
        // Incomplete host/test doubles — fall through to global map
      }
    }

    // 3. Fall back to global Symbol.for map (existing captureRegisteredProviderStreams)
    const providerStreams: Map<string, Function> | undefined = (globalThis as any)[
      PROVIDER_STREAMS_KEY
    ];
    if (providerStreams) {
      const customFn =
        model?.provider && model?.api
          ? providerStreams.get(providerStreamKey(model.provider, model.api))
          : undefined;
      if (customFn) return customFn(model, ctx, o);
    }

    // 4. Final fallback to compat
    return streamSimple(model, ctx, o);
  };
  return (model: any, ctx: any, opts: any) => {
    // Generic attribution: apply provider-required headers from the standard
    // `sessionId` stream option (pi-ai `SimpleStreamOptions`). agentLoop spreads
    // the full AgentLoopConfig into stream opts, so workers only need
    // `sessionId` in their loop config — no per-provider branching here.
    // Both layers are applied: pre-merged `headers` (for custom streams that
    // ignore `transformHeaders`) and a composed `transformHeaders` (honored by
    // pi-ai `applyAuth` after auth-header merge, i.e. pi's own layer).
    const rawSessionId = (opts as { sessionId?: unknown } | null | undefined)?.sessionId;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : undefined;
    if (!sessionId) return dispatch(model, ctx, opts);
    const headers = withProviderAttributionHeaders(model, opts?.headers, sessionId);
    const incoming = (opts as { transformHeaders?: unknown } | null | undefined)?.transformHeaders;
    const incomingTransform =
      typeof incoming === "function" ? (incoming as AttributionTransform) : undefined;
    // Fast path: unrelated provider, no caller transform — pass through untouched.
    if (headers === opts?.headers && incomingTransform === undefined) {
      return dispatch(model, ctx, opts);
    }
    return dispatch(model, ctx, {
      ...opts,
      headers,
      transformHeaders: createAttributionTransform(model, sessionId, incomingTransform),
    });
  };
}
