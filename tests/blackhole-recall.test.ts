/**
 * Tests for /blackhole-recall command — search session history.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `pi-blackhole-recall-test-${process.pid}-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => join(testRoot, "agent"),
}));

import { registerVccRecallCommand } from "../src/commands/vcc-recall.js";

function createMockEnvironment() {
	const sentMessages: Array<{ content: string; customType: string }> = [];
	const handlerMap = new Map<string, (args: string, ctx: unknown) => Promise<void>>();

	const pi: any = {
		registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			handlerMap.set(name, def.handler);
		}),
		sendMessage: vi.fn((msg: { content: string; customType: string; display: boolean }, opts: { triggerTurn: boolean }) => {
			sentMessages.push(msg);
		}),
	};

	/** Build a minimal session file with test messages */
	function createSessionFile(messages: Array<{ role: string; content: string }>): string {
		const dir = join(testRoot, "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `session-${Date.now()}.jsonl`);
		const lines = messages.map((m, i) => JSON.stringify({
			type: "message",
			id: `m${i}`,
			timestamp: new Date().toISOString(),
			message: m,
		}));
		writeFileSync(file, lines.join("\n") + "\n", "utf-8");
		return file;
	}

	return { pi, handlerMap, sentMessages, createSessionFile };
}

describe("/blackhole-recall command", () => {
	beforeEach(() => {
		mkdirSync(testRoot, { recursive: true });
	});

	afterEach(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	it("registers the blackhole-recall command", () => {
		const { pi } = createMockEnvironment();
		registerVccRecallCommand(pi as any);
		expect(pi.registerCommand).toHaveBeenCalledWith("blackhole-recall", expect.any(Object));
		const callArgs = pi.registerCommand.mock.calls[0];
		expect(callArgs[0]).toBe("blackhole-recall");
		expect(callArgs[1].description.toLowerCase()).toContain("search");
	});

	it("shows recent entries when no query is provided", async () => {
		const { pi, handlerMap, sentMessages, createSessionFile } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		const sessionFile = createSessionFile([
			{ role: "user", content: "Hello there" },
			{ role: "assistant", content: "Hi, how can I help?" },
		]);

		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => sessionFile),
				getBranch: vi.fn(() => [{ id: "m0" }, { id: "m1" }]),
				getSessionId: vi.fn(() => "test-session"),
			},
		};

		await handlerMap.get("blackhole-recall")!("", ctx);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].customType).toBe("blackhole-recall");
		expect(sentMessages[0].content).toContain("#0");
		expect(sentMessages[0].content).toContain("#1");
	});

	it("searches and returns matches for a query", async () => {
		const { pi, handlerMap, sentMessages, createSessionFile } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		const sessionFile = createSessionFile([
			{ role: "user", content: "Fix login bug" },
			{ role: "assistant", content: "I will fix the authentication module" },
		]);

		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => sessionFile),
				getBranch: vi.fn(() => [{ id: "m0" }, { id: "m1" }]),
				getSessionId: vi.fn(() => "test-session"),
			},
		};

		await handlerMap.get("blackhole-recall")!("login", ctx);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].content).toContain("1 matches");
		expect(sentMessages[0].content).toContain("login bug");
	});

	it("returns empty when no matches found", async () => {
		const { pi, handlerMap, sentMessages, createSessionFile } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		const sessionFile = createSessionFile([
			{ role: "user", content: "Hello" },
		]);

		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => sessionFile),
				getBranch: vi.fn(() => [{ id: "m0" }]),
				getSessionId: vi.fn(() => "test-session"),
			},
		};

		await handlerMap.get("blackhole-recall")!("nonexistent", ctx);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].content).toContain('No matches for "nonexistent"');
	});

	it("shows error when no session file is available", async () => {
		const { pi, handlerMap, sentMessages } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		const notifyCalls: Array<{ msg: string; level: string }> = [];
		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => undefined),
			},
			ui: {
				notify: vi.fn((msg: string, level: string) => {
					notifyCalls.push({ msg, level });
				}),
			},
		};

		await handlerMap.get("blackhole-recall")!("test", ctx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].msg).toContain("No session file available");
		expect(notifyCalls[0].level).toBe("error");
	});

	it("scope:all includes off-lineage results", async () => {
		const { pi, handlerMap, sentMessages, createSessionFile } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		const sessionFile = createSessionFile([
			{ role: "user", content: "Public info" },
			{ role: "assistant", content: "Secret info" },
		]);

		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => sessionFile),
				getBranch: vi.fn(() => [{ id: "m0" }]), // only first entry in lineage
				getSessionId: vi.fn(() => "test-session"),
			},
		};

		await handlerMap.get("blackhole-recall")!("Secret scope:all", ctx);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].content).toContain("1 matches");
		expect(sentMessages[0].content).toContain("Secret info");
	});

	it("pagination via page:N works", async () => {
		const { pi, handlerMap, sentMessages, createSessionFile } = createMockEnvironment();
		registerVccRecallCommand(pi as any);

		// Create enough messages to test pagination
		const msgs: Array<{ role: string; content: string }> = [];
		for (let i = 0; i < 8; i++) {
			msgs.push({ role: "user", content: `test message ${i}` });
		}
		const sessionFile = createSessionFile(msgs);

		const ctx: any = {
			sessionManager: {
				getSessionFile: vi.fn(() => sessionFile),
				getBranch: vi.fn(() => msgs.map((_, i) => ({ id: `m${i}` }))),
				getSessionId: vi.fn(() => "test-session"),
			},
		};

		await handlerMap.get("blackhole-recall")!("test page:2", ctx);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].content).toContain("Page 2/2");
	});
});
