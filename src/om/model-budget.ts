import type { Model } from "@earendil-works/pi-ai";
import type { OmModelConfig } from "../core/unified-config.js";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

export function boundedMaxTokens(model: Model<any>, requested: number = AGENT_LOOP_MAX_TOKENS): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? Math.min(model.maxTokens, requested)
		: requested;
}

/**
 * Get the effective context window for a resolved model.
 *
 * Resolution order:
 * 1. Config override on the model config (OmModelConfig.contextWindow)
 * 2. Pi's model registry value (model.contextWindow)
 * 3. Fallback default (128000)
 */
export function effectiveContextWindow(
	resolvedModel: Model<any>,
	modelConfig?: OmModelConfig,
): number {
	if (modelConfig?.contextWindow !== undefined && modelConfig.contextWindow > 0) {
		return modelConfig.contextWindow;
	}
	if (typeof resolvedModel.contextWindow === "number" && resolvedModel.contextWindow > 0) {
		return resolvedModel.contextWindow;
	}
	return 128_000;
}
