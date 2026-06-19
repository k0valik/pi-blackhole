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
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});

	test("observer NOT due when no cursor and tokens below threshold (no observation markers)", async () => {
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
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);  // no observer markers → raw tokens counted from scratch
	});

	test("dropper NOT due when cursor advanced and no new data, no pressure", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 5;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;
		// Cursor advanced past all entries, pool < 10%, no new data → dropper NOT due
		const entries = [
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }] } },
		];
		runtime.advanceCursor("dropper", "obs-1", "skipped");
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
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
		expect(anyStageDue(entries, runtime, undefined)).toBe(true);
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
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});
});

	describe("anyStageDue with pending state (manual mode)", () => {
		test("reflector due when pending observation batch exists after cursor", async () => {
			const { Runtime } = await import("../src/om/runtime.js");
			const { anyStageDue } = await import("../src/om/consolidation.js");
			const runtime = new Runtime();
			runtime.config.observeAfterTokens = 100000;
			runtime.config.reflectAfterTokens = 10;
			runtime.config.observationsPoolMaxTokens = 100_000;
			runtime.config.dropperPressureThreshold = 0.70;
			runtime.config.reflectorInputMaxTokens = 500;
			const entries = [
				{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
				{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			];
			runtime.advanceCursor("reflector", "msg-1", "recorded");
			const pending: any = {
				observationBatches: [{ coversUpToId: "msg-2", data: { observations: [] } }],
			};
			expect(anyStageDue(entries, runtime, pending)).toBe(true);
		});



		test("dropper due when pending pool exceeds threshold (manual mode)", async () => {
			const { Runtime } = await import("../src/om/runtime.js");
			const { anyStageDue } = await import("../src/om/consolidation.js");
			const runtime = new Runtime();
			runtime.config.observeAfterTokens = 100000;
			runtime.config.reflectAfterTokens = 100000;
			runtime.config.observationsPoolMaxTokens = 1000;
			runtime.config.dropperPressureThreshold = 0.99;
			runtime.config.reflectorInputMaxTokens = 1000;
			// Branch has conversation entries (normal manual mode), no OM markers.
			const entries = [
				{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			];
			const pending: any = {
				observationBatches: [{
					coversUpToId: "msg-1",
					data: { observations: [{ id: "o1", content: "x".repeat(500), tokenCount: 125 }] },
				}],
			};
			// No cursors → rawTokensSinceDropCoverage on entries with conversation
			// → some tokens > 0.  Pool from pending: 125/1000 = 12.5% > 10%.
			// Both gates pass → dropper due.
			expect(anyStageDue(entries, runtime, pending)).toBe(true);
		});

		test("pipeline launches when observer not due but pending has new data for reflector", async () => {
			const { Runtime } = await import("../src/om/runtime.js");
			const { anyStageDue } = await import("../src/om/consolidation.js");
			const runtime = new Runtime();
			runtime.config.observeAfterTokens = 100000;
			runtime.config.reflectAfterTokens = 5;
			runtime.config.observationsPoolMaxTokens = 100_000;
			runtime.config.dropperPressureThreshold = 0.99;
			runtime.config.reflectorInputMaxTokens = 500;
			// Observer cursor advanced past all entries → not due
			// Reflector cursor is behind (at msg-1), new batch at msg-2
			const entries = [
				{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "old" }] } },
				{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "new message after reflector cursor" }] } },
			];
			runtime.advanceCursor("observer", "msg-2", "recorded");  // advanced past all
			runtime.advanceCursor("reflector", "msg-1", "recorded");  // still at msg-1
			// Pending has a NEW batch (coversUpToId after the reflector cursor)
			const pending: any = {
				observationBatches: [
					{ coversUpToId: "msg-1", data: { observations: [] } },  // old, cursor is here
					{ coversUpToId: "msg-2", data: { observations: [{ id: "o2", content: "fresh", tokenCount: 10 }] } },  // new!
				],
			};
			// Reflector should see the new batch at msg-2 (after cursor at msg-1)
			expect(anyStageDue(entries, runtime, pending)).toBe(true);
		});

		test("reflector due when cursor state 'initial' and pending batch exists after cursor", async () => {
			const { Runtime } = await import("../src/om/runtime.js");
			const { anyStageDue } = await import("../src/om/consolidation.js");
			const runtime = new Runtime();
			runtime.config.observeAfterTokens = 100000;
			runtime.config.reflectAfterTokens = 10;
			runtime.config.observationsPoolMaxTokens = 100_000;
			runtime.config.dropperPressureThreshold = 0.70;
			runtime.config.reflectorInputMaxTokens = 500;

			// Branch entries - cursor fell back to msg-1 coverage marker (state "initial")
			const entries = [
				{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
				{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			];
			runtime.advanceCursor("reflector", "msg-1", "initial");

			// Pending has a new batch at msg-2 (after cursor at msg-1)
			const pending: any = {
				observationBatches: [
					{ coversUpToId: "msg-2", data: { observations: [{ id: "a1b2c3d4e5f6", content: "fresh", timestamp: "2025-01-01T00:00:00Z", relevance: "medium", sourceEntryIds: ["msg-2"], tokenCount: 10 }] } },
				],
			};

			// Reflector should see new pending batch even when cursor.state is "initial"
			expect(anyStageDue(entries, runtime, pending)).toBe(true);
		});
	});

describe("anyStageDue cursor vs branch-marker coversUpToId (auto mode)", () => {
	test("reflector NOT due: marker after cursor but coversUpToId IS the cursor entry", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 10;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;

		// Cursor at msg-1. There's an OM_OBSERVATIONS_RECORDED marker AFTER msg-1
		// in the branch, but its coversUpToId IS msg-1 - data was already processed.
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "msg-1", observations: [{ id: "o1", content: "test", tokenCount: 10 }] } },
		];
		runtime.advanceCursor("reflector", "msg-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});

	test("reflector IS due: marker after cursor with coversUpToId truly past cursor", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 10;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;

		// Cursor at msg-1. Marker's coversUpToId is msg-2 (truly after cursor) → new data.
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "msg-2", observations: [{ id: "o1", content: "test", tokenCount: 10 }] } },
		];
		runtime.advanceCursor("reflector", "msg-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(true);
	});

	test("dropper NOT due: marker after cursor but coversUpToId at cursor, pool too low", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 100000;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;

		// Cursor at obs-1. Marker at obs-2 after it, but coversUpToId is obs-1.
		// Observer + reflector not due → dropper check runs.
		// Pool is tiny → below 10% → dropper NOT due.
		const entries = [
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "msg-0", observations: [{ id: "o1", content: "a", tokenCount: 1 }] } },
			{ type: "custom", id: "obs-2", customType: "om.observations.recorded", data: { coversUpToId: "obs-1", observations: [{ id: "o2", content: "b", tokenCount: 1 }] } },
		];
		runtime.advanceCursor("dropper", "obs-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});

	test("dropper IS due: marker coversUpToId truly after cursor AND pool above threshold", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 5;  // low enough that 6 tokens (> msg-2) passes the guard
		runtime.config.observationsPoolMaxTokens = 1000;
		runtime.config.dropperPressureThreshold = 0.99;
		runtime.config.reflectorInputMaxTokens = 1000;

		// Cursor at msg-1, new obs batch at obs-1 with coversUpToId msg-2 (after cursor).
		// tokensSince ≈ 6 > reflectAfterTokens(5) → passes token guard.
		// Pool: 500 tokens / 1000 max = 50% > 10% → dropper due.
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "old" }] } },
			{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "new data after cursor" }] } },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "msg-2", observations: [{ id: "a1b2c3d4e5f6", content: "x".repeat(2000), timestamp: "2025-01-01T00:00:00Z", relevance: "medium", sourceEntryIds: ["msg-2"], tokenCount: 500 }] } },
		];
		runtime.advanceCursor("dropper", "msg-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(true);
	});


	test("dropper NOT due: new batches exist after cursor but token threshold not met", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 500;  // need 500 tokens to pass guard
		runtime.config.observationsPoolMaxTokens = 1000;
		runtime.config.dropperPressureThreshold = 0.99;
		runtime.config.reflectorInputMaxTokens = 1000;

		// Cursor at msg-1. New obs batch at obs-1 with coversUpToId msg-2 (truly after cursor).
		// Pool: 500/1000 = 50% > 10%.
		// But only ~6 tokens since cursor < reflectAfterTokens(500) → dropper NOT due.
		const entries = [
			{ type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "old" }] } },
			{ type: "message", id: "msg-2", message: { role: "user", content: [{ type: "text", text: "new data after cursor" }] } },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "msg-2", observations: [{ id: "a1b2c3d4e5f6", content: "x".repeat(2000), timestamp: "2025-01-01T00:00:00Z", relevance: "medium", sourceEntryIds: ["msg-2"], tokenCount: 500 }] } },
		];
		runtime.advanceCursor("dropper", "msg-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});
	test("reflector NOT due when state 'empty' and marker coversUpToId at cursor (exact production scenario)", async () => {
		const { Runtime } = await import("../src/om/runtime.js");
		const { anyStageDue } = await import("../src/om/consolidation.js");
		const runtime = new Runtime();
		runtime.config.observeAfterTokens = 100000;
		runtime.config.reflectAfterTokens = 10;
		runtime.config.observationsPoolMaxTokens = 100_000;
		runtime.config.dropperPressureThreshold = 0.70;
		runtime.config.reflectorInputMaxTokens = 500;

		// Production scenario: cursor at source entry aea5b9b7 (state 'empty'),
		// observation marker 13c906d0 exists AFTER it but has coversUpToId: aea5b9b7.
		// The reflector already processed this data → should NOT be due.
		const entries = [
			{ type: "message", id: "source-1", message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] } },
			{ type: "custom", id: "ref-1", customType: "om.reflections.recorded", data: { coversUpToId: "first-obs", reflections: [] } },
			{ type: "custom", id: "obs-1", customType: "om.observations.recorded", data: { coversUpToId: "source-1", observations: [{ id: "o1", content: "test", tokenCount: 10 }] } },
		];
		runtime.advanceCursor("reflector", "source-1", "empty");
		expect(anyStageDue(entries, runtime, undefined)).toBe(false);
	});
});
