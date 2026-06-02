import { describe, test, expect } from "vitest";
import { Runtime } from "../src/om/runtime.js";
import { makeModelResolver, type ConsolidationCtx } from "../src/om/consolidation.js";

function mockCtx(notifyCalls: Array<{ message: string; level?: string }>): ConsolidationCtx {
	return {
		cwd: "/tmp",
		hasUI: true,
		ui: {
			notify: (message: string, type?: "warning" | "info" | "error") => {
				notifyCalls.push({ message, level: type });
			},
		},
		model: undefined,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "test-session",
		},
	};
}

describe("makeModelResolver — per-stage failure notifications", () => {
	test("each stage shows its own failure notification when no models are available", async () => {
		const runtime = new Runtime("/tmp");
		runtime.config.memory = true;
		// No observer/reflector/dropper models configured → all fail
		runtime.config.observerModel = undefined;
		runtime.config.reflectorModel = undefined;
		runtime.config.dropperModel = undefined;
		runtime.config.observerFallbackModels = [];
		runtime.config.reflectorFallbackModels = [];
		runtime.config.dropperFallbackModels = [];

		const notifyCalls: Array<{ message: string; level?: string }> = [];
		const ctx = mockCtx(notifyCalls);
		const resolver = makeModelResolver(runtime, ctx);

		// Observer stage fails → should show notification
		runtime.consolidationPhase = "observer";
		runtime.resolveFailureNotified = false;
		const observerResult = await resolver("observer");
		expect(observerResult).toBeUndefined();
		expect(notifyCalls.length).toBe(1);
		expect(notifyCalls[0]!.message).toContain("observer skipped");

		// Pipeline resets the flag at each stage boundary
		runtime.resolveFailureNotified = false;

		// Reflector stage ALSO fails → should show its own notification
		runtime.consolidationPhase = "reflector";
		const reflectorResult = await resolver("reflector");
		expect(reflectorResult).toBeUndefined();
		expect(notifyCalls.length).toBe(2);
		expect(notifyCalls[1]!.message).toContain("reflector skipped");
	});
});
