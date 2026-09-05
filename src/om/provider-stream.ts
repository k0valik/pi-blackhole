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

export function captureRegisteredProviderStreams(
  registry: ProviderRegistry,
  providerStreams: Map<string, Function>,
): void {
  if (registry.getRegisteredProviderIds && registry.getRegisteredProviderConfig) {
    for (const providerId of registry.getRegisteredProviderIds()) {
      const config = registry.getRegisteredProviderConfig(providerId);
      if (config?.streamSimple && config.api && !providerStreams.has(config.api)) {
        providerStreams.set(config.api, config.streamSimple);
      }
    }
    return;
  }

  registry.registeredProviders?.forEach((config) => {
    if (config.streamSimple && config.api && !providerStreams.has(config.api)) {
      providerStreams.set(config.api, config.streamSimple);
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

export function createBridgeStreamFn(streamSimple: any) {
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  return (model: any, ctx: any, opts: any) => {
    const providerStreams: Map<string, Function> | undefined = (globalThis as any)[
      PROVIDER_STREAMS_KEY
    ];
    if (!providerStreams) return streamSimple(model, ctx, opts);
    const customFn = model?.api ? providerStreams.get(model.api) : undefined;
    return customFn ? customFn(model, ctx, opts) : streamSimple(model, ctx, opts);
  };
}
