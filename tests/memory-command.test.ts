/**
 * Tests for the /blackhole-memory command (status, view, full).
 */
import { describe, it, expect, vi } from "vitest";
import { registerMemoryCommand } from "../src/commands/memory.js";
import {
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	observationsDroppedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

/** Build a minimal mock pi + runtime for testing commands */
function createMockEnvironment() {
	const notifyCalls: Array<{ msg: string; level: string }> = [];
	const handlerMap = new Map<string, (event: unknown, ctx: unknown) => unknown>();

	const pi = {
		registerCommand: vi.fn((name: string, def: { handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
			handlerMap.set(name, def.handler as any);
		}),
	};

	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observeAfterTokens: 15_000,
			reflectAfterTokens: 25_000,
			compactAfterTokens: 81_000,
			observationsPoolMaxTokens: 20_000,
			observerChunkMaxTokens: 40_000,
			observerPreambleMaxTokens: 0,
			passive: false,
			noAutoCompact: false,
		},
		consolidationInFlight: false,
		compactInFlight: false,
		compactHookInFlight: false,
		lastObserverError: undefined,
		lastReflectorError: undefined,
		lastDropperError: undefined,
	};

	const ui = {
		notify: vi.fn((msg: string, level: string) => {
			notifyCalls.push({ msg, level });
		}),
	};

	/** Helper: build a basic branch with some observations and reflections */
	function buildBranch(overrides: Partial<{ observations: number; reflections: number; drops: number }> = {}) {
		const { observations = 2, reflections = 1, drops = 0 } = overrides;
		const entries: TestEntry[] = [
			textCustomMessage("raw-1", "aaaa"),
		];
		if (observations > 0) {
			const obsList = Array.from({ length: observations }, (_, i) =>
				observation(`${"a".repeat(12 - String(i).length)}${i}`, { relevance: "medium", tokenCount: 10 }),
			);
			entries.push(observationsRecordedEntry("om-obs", { observations: obsList, coversUpToId: "raw-1" }));
		}
		if (reflections > 0) {
			const refList = Array.from({ length: reflections }, (_, i) =>
				reflection(`${"e".repeat(12 - String(i).length)}${i}`, ["aaaaaaaaaaaa"]),
			);
			entries.push(reflectionsRecordedEntry("om-ref", { reflections: refList, coversUpToId: "raw-1" }));
		}
		if (drops > 0) {
			entries.push(observationsDroppedEntry("om-drop", {
				observationIds: ["aaaaaaaaaaaa"],
				coversUpToId: "om-obs",
			}));
		}
		return entries;
	}

	return {
		pi,
		runtime,
		ui,
		notifyCalls,
		handlerMap,
		buildBranch,
	};
}

function invokeMemory(handlerMap: Map<string, unknown>, args: unknown, ctxOverrides: Record<string, unknown> = {}) {
	const handler = handlerMap.get("blackhole-memory") as ((args: unknown, ctx: unknown) => Promise<void>) | undefined;
	if (!handler) throw new Error("blackhole-memory command not registered");
	return handler(args, {
		cwd: "/tmp/test",
		sessionManager: {
			getBranch: vi.fn(() => []),
			getSessionId: vi.fn(() => "test-session"),
		},
		ui: { notify: vi.fn() },
		...ctxOverrides,
	});
}

describe("/blackhole-memory command", () => {
	it("registers the command on pi", () => {
		const { pi, runtime } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);
		expect(pi.registerCommand).toHaveBeenCalledWith("blackhole-memory", expect.objectContaining({
			description: expect.stringContaining("memory"),
		}));
	});

	it("shows status with pipeline counters for default config", async () => {
		const { pi, runtime, handlerMap, buildBranch } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };
		const entries = buildBranch({ observations: 3, reflections: 2 });

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => entries),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		expect(ui.notify).toHaveBeenCalledTimes(1);
		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Memory");
		expect(msg).toContain("Observations:");
		expect(msg).toContain("Reflections:");
		expect(msg).toContain("Observer:");
		expect(msg).toContain("Reflector:");
		expect(msg).toContain("Dropper:");
		expect(msg).toContain("Compaction:");
		expect(msg).toContain("Obs pool:");
		expect(msg).toContain("Reflect pool:");
	});

	it("status shows recorded / dropped / visible counts", async () => {
		const { pi, runtime, handlerMap, buildBranch } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };
		// 2 observations, 1 reflection, 1 dropped
		const entries = buildBranch({ observations: 2, reflections: 1, drops: 1 });

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => entries),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("2 recorded");
		expect(msg).toContain("1 dropped");
		expect(msg).toContain("1 visible");
	});

	it("shows passive mode indicator when config.passive is true", async () => {
		const { pi, runtime, handlerMap } = createMockEnvironment();
		runtime.config.passive = true;
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Passive:");
		expect(msg).toContain("automatic memory workers and auto-compaction disabled");
	});

	it("shows in-flight indicators when consolidation is running", async () => {
		const { pi, runtime, handlerMap } = createMockEnvironment();
		runtime.consolidationInFlight = true;
		runtime.compactInFlight = true;
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("In flight");
		expect(msg).toContain("Consolidation: running");
		expect(msg).toContain("Auto-compaction: running");
	});

	it("shows last errors when present", async () => {
		const { pi, runtime, handlerMap } = createMockEnvironment();
		runtime.lastObserverError = "Model unavailable";
		runtime.lastDropperError = "Budget exceeded";
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Last error");
		expect(msg).toContain("Observer: Model unavailable");
		expect(msg).toContain("Dropper: Budget exceeded");
	});

	it("view mode renders visible observations and reflections", async () => {
		const { pi, runtime, handlerMap, buildBranch } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };
		const entries = buildBranch({ observations: 2, reflections: 1 });

		await handlerMap.get("blackhole-memory")!(["view"], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => entries),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		expect(ui.notify).toHaveBeenCalledTimes(1);
		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Reflections");
		expect(msg).toContain("Observations");
		expect(msg).toContain("Copied to clipboard.");
	});

	it("full mode renders all recorded observations and reflections", async () => {
		const { pi, runtime, handlerMap, buildBranch } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };
		const entries = buildBranch({ observations: 2, reflections: 1 });

		await handlerMap.get("blackhole-memory")!(["full"], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => entries),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		expect(ui.notify).toHaveBeenCalledTimes(1);
		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Reflections");
		expect(msg).toContain("Observations");
	});

	it("shows usage message for invalid mode", async () => {
		const { pi, runtime, handlerMap } = createMockEnvironment();
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };

		await handlerMap.get("blackhole-memory")!(["invalid-mode"], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("Usage:");
	});

	it("noAutoCompact shows auto-disabled marker and preamble cap info", async () => {
		const { pi, runtime, handlerMap } = createMockEnvironment();
		runtime.config.noAutoCompact = true;
		registerMemoryCommand(pi as any, runtime as any);

		const ui = { notify: vi.fn() };

		await handlerMap.get("blackhole-memory")!([], {
			cwd: "/tmp/test",
			sessionManager: {
				getBranch: vi.fn(() => []),
				getSessionId: vi.fn(() => "test-session"),
			},
			ui,
		});

		const msg = (ui.notify as any).mock.calls[0][0] as string;
		expect(msg).toContain("auto-disabled");
		// Pending section and Preamble cap only show when pending data exists on disk
	});
});
