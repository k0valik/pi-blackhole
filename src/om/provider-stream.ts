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
 * `config.api === model.api`.
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
  return (model: any, ctx: any, opts: any) => {
    // 1. Check modelRegistry.streamSimple (host-composed facade, Pi #8964)
    if (modelRegistry && typeof (modelRegistry as any).streamSimple === "function") {
      return (modelRegistry as any).streamSimple(model, ctx, opts);
    }

    // 2. Iterate getRegisteredProviderConfig to find matching model.api
    if (
      modelRegistry &&
      typeof (modelRegistry as any).getRegisteredProviderIds === "function" &&
      typeof (modelRegistry as any).getRegisteredProviderConfig === "function"
    ) {
      try {
        for (const providerId of (modelRegistry as any).getRegisteredProviderIds()) {
          const config = (modelRegistry as any).getRegisteredProviderConfig(providerId);
          if (config?.api === model.api && typeof config.streamSimple === "function") {
            return config.streamSimple(model, ctx, opts);
          }
        }
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
      if (customFn) return customFn(model, ctx, opts);
    }

    // 4. Final fallback to compat
    return streamSimple(model, ctx, opts);
  };
}
