/**
 * Bridge streamSimple to support custom providers via global Symbol.for().
 *
 * When a custom provider is registered (via index.ts at startup), its stream
 * function is stored under a shared global symbol. This module provides the
 * bridge logic so all OM agents (observer, reflector, dropper) use the same
 * custom-provider resolution instead of each duplicating the 15-line function.
 */
export function createBridgeStreamFn(streamSimple: any) {
	const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
	return (model: any, ctx: any, opts: any) => {
		const providerStreams: Map<string, Function> | undefined = (globalThis as any)[PROVIDER_STREAMS_KEY];
		if (!providerStreams) return streamSimple(model, ctx, opts);
		const customFn = model?.api ? providerStreams.get(model.api) : undefined;
		return customFn ? customFn(model, ctx, opts) : streamSimple(model, ctx, opts);
	};
}
