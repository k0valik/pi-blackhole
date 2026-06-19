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

describe("anyStageDue with cursors", () => {
	test("observer NOT due when cursor has advanced past all entries", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		// Fake config - observe threshold is 100 tokens
		runtime.config.observeAfterTokens = 100;
		runtime.config.reflectAfterTokens = 100000;  // keep reflector/dropper from being due
		runtime.config.observationsPoolMaxTokens = 1000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// Cursor has advanced past all entries → observer should NOT be due
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "hello world this is a long message that should be over 100 tokens worth of characters" }] } },
		];
		runtime.advanceCursor("observer", "msg-1", "empty");
		expect(anyStageDue(entries, runtime)).toBe(false);
	});

	test("observer IS due when no cursor and tokens exceed threshold", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100;
		runtime.config.reflectAfterTokens = 100000;
		runtime.config.observationsPoolMaxTokens = 1000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// No cursor, tokens over threshold → observer should be due
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "hello world this is a long message that should be over 100 tokens worth of characters and more stuff to make it longer and longer and longer" }] } },
		];
		expect(anyStageDue(entries, runtime)).toBe(false);  // no observer markers → raw tokens counted from scratch
	});

	test("dropper NOT due when cursor advanced and no new data, no pressure", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 10;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// Cursor advanced past all entries, pool < 10%, no new data → dropper NOT due
		const entries = [
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }] } },
		];
		runtime.advanceCursor("dropper", "obs-1", "skipped");
		expect(anyStageDue(entries, runtime)).toBe(false);
	});

	test("reflector due when new observation batches exist AND token threshold met", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 10;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// Cursor at msg-1, enough tokens after cursor (msg-2 has 200 chars ~50 tokens) + new obs batch → reflector due
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "cursor here" }] } },
			{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			{ type: "custom", id: "obs-2", customType: "om.observations.recorded", data: { observations: [] } },
		];
		runtime.advanceCursor("reflector", "msg-1", "recorded");
		expect(anyStageDue(entries, runtime)).toBe(true);
	});

	test("reflector NOT due when new obs batch exists but token threshold NOT met", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 500;  // need 500 tokens
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// Cursor at msg-1, only 50 chars (~12 tokens) after cursor (msg-2) → below 500 threshold
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "cursor here" }] } },
			{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "tiny" }] } },
			{ type: "custom", id: "obs-2", customType: "om.observations.recorded", data: { observations: [] } },
		];
		runtime.advanceCursor("reflector", "msg-1", "recorded");
		expect(anyStageDue(entries, runtime)).toBe(false);
	});
});
