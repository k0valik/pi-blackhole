import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import {
  compactInlineAtTurnBoundary,
  InlineCompactionUnavailableError,
  installHostInlineCompactionAdapter,
  installInlineCompactionAdapter,
  parseHostFramePaths,
} from "../src/om/inline-compaction.js";
import { createPiAgentSessionHarness } from "./fixtures/pi-agent-session.js";

interface FakeTurnContext {
  messages: unknown[];
  systemPrompt: string;
  tools: unknown[];
}

interface FakeTurn {
  context: FakeTurnContext;
}

function createDeferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  return {
    promise,
    release() {
      if (released) return;
      released = true;
      release();
    },
  };
}

function createSessionClass(options: {
  legacyDisconnect?: boolean;
  activeMessages?: unknown[];
  summaryGate?: Promise<void>;
}) {
  const activeMessages = options.activeMessages ?? [
    { role: "user", content: "before" },
    { role: "assistant", content: "done", stopReason: "stop" },
  ];

  class FakeSessionBase {
    originalAbortCalls = 0;
    disconnectCalls = 0;
    reconnectCalls = 0;
    bindCalls = 0;
    compactCalls = 0;
    customInstructions: string | undefined;
    _compactionAbortController: AbortController | undefined;
    _autoCompactionAbortController: AbortController | undefined;

    sessionManager = {
      buildSessionContext: vi.fn(() => ({ messages: activeMessages })),
      appendCompaction: vi.fn(),
    };

    agent = {
      state: {
        messages: [{ role: "user", content: "stale" }] as unknown[],
      },
      prepareNextTurnWithContext: vi.fn(
        async (turn: FakeTurn): Promise<{ context: FakeTurnContext }> => ({
          context: turn.context,
        }),
      ),
    };

    async abort(): Promise<void> {
      this.originalAbortCalls += 1;
      this._compactionAbortController?.abort();
    }

    _disconnectFromAgent(): void {
      this.disconnectCalls += 1;
    }

    _reconnectToAgent(): void {
      this.reconnectCalls += 1;
    }

    _bindExtensionCore(runner: unknown): void {
      void runner;
      this.bindCalls += 1;
    }
  }

  if (options.legacyDisconnect) {
    return class LegacySession extends FakeSessionBase {
      async compact(customInstructions?: string) {
        this._disconnectFromAgent();
        await this.abort();
        this._compactionAbortController = new AbortController();
        try {
          await options.summaryGate;
          if (this._compactionAbortController.signal.aborted) {
            throw new Error("Compaction cancelled");
          }
          this.compactCalls += 1;
          this.customInstructions = customInstructions;
          this.sessionManager.appendCompaction();
          this.agent.state.messages = [
            { role: "user", content: "summary" },
            { role: "assistant", content: "kept-tail" },
          ];
          return {
            summary: "summary",
            firstKeptEntryId: "kept-1",
            tokensBefore: 42,
          };
        } finally {
          this._compactionAbortController = undefined;
          this._reconnectToAgent();
        }
      }
    };
  }

  return class ModernSession extends FakeSessionBase {
    async compact(customInstructions?: string) {
      await this.abort();
      this._compactionAbortController = new AbortController();
      try {
        await options.summaryGate;
        if (this._compactionAbortController.signal.aborted) {
          throw new Error("Compaction cancelled");
        }
        this.compactCalls += 1;
        this.customInstructions = customInstructions;
        this.sessionManager.appendCompaction();
        this.agent.state.messages = [
          { role: "user", content: "summary" },
          { role: "assistant", content: "kept-tail" },
        ];
        return {
          summary: "summary",
          firstKeptEntryId: "kept-1",
          tokensBefore: 42,
        };
      } finally {
        this._compactionAbortController = undefined;
      }
    }
  };
}

async function refreshNextTurn(
  session: InstanceType<ReturnType<typeof createSessionClass>>,
) {
  return await session.agent.prepareNextTurnWithContext(
    {
      context: {
        messages: [{ role: "user", content: "uncompacted-loop-snapshot" }],
        systemPrompt: "system",
        tools: [],
      },
    },
    new AbortController().signal,
  );
}

describe("Blackhole inline compaction adapter", () => {
  it.each([
    ["Pi 0.81 legacy disconnect shape", true],
    ["Pi 0.84 connected-listener shape", false],
  ])(
    "compacts without aborting the active run on %s",
    async (_label, legacyDisconnect) => {
      const SessionClass = createSessionClass({ legacyDisconnect });
      const status = installInlineCompactionAdapter({
        sessionClass: SessionClass as never,
      });
      const session = new SessionClass();

      session._bindExtensionCore({});
      const result = await compactInlineAtTurnBoundary(
        session.sessionManager,
        "preserve active work",
      );

      expect(status).toEqual({ supported: true });
      expect(result.summary).toBe("summary");
      expect(session.customInstructions).toBe("preserve active work");
      expect(session.compactCalls).toBe(1);
      expect(session.originalAbortCalls).toBe(0);
      expect(session.disconnectCalls).toBe(0);
      expect(session.reconnectCalls).toBe(legacyDisconnect ? 1 : 0);
      expect(session.bindCalls).toBe(1);
    },
  );

  it("replaces the low-level loop snapshot with compacted agent messages on the next turn", async () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await compactInlineAtTurnBoundary(session.sessionManager);
    const next = await refreshNextTurn(session);

    expect(next.context.messages).toEqual([
      { role: "user", content: "summary" },
      { role: "assistant", content: "kept-tail" },
    ]);
  });

  it("rejects before mutation when the active branch has an unpaired tool call", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
          ],
        },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toThrow("tool call is still in flight");
    expect(session.compactCalls).toBe(0);
    expect(session.originalAbortCalls).toBe(0);
  });

  it("ignores an unpaired tool call from a superseded assistant turn", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "stale-write",
              name: "write",
              arguments: {},
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "current-read",
              name: "read",
              arguments: {},
            },
          ],
        },
        { role: "toolResult", toolCallId: "current-read", content: [] },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).resolves.toMatchObject({ summary: "summary" });
    expect(session.compactCalls).toBe(1);
  });

  it("rejects when any call in the latest parallel tool batch is unpaired", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-1", name: "read", arguments: {} },
            { type: "toolCall", id: "read-2", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", toolCallId: "read-1", content: [] },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toThrow("tool call is still in flight");
    expect(session.compactCalls).toBe(0);
  });

  it("allows inline compaction when the latest assistant turn was aborted", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        fauxAssistantMessage(fauxToolCall("read", {}, { id: "stale-read" }), {
          stopReason: "aborted",
        }),
        fauxAssistantMessage(fauxToolCall("read", {}, { id: "current-read" }), {
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "current-read",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).resolves.toMatchObject({ summary: "summary" });
    expect(session.compactCalls).toBe(1);
  });

  it("allows inline compaction when the latest assistant turn errored", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        fauxAssistantMessage(fauxToolCall("write", {}, { id: "stale-write" }), {
          stopReason: "error",
          errorMessage: "provider error",
        }),
        fauxAssistantMessage(fauxToolCall("read", {}, { id: "current-read" }), {
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "current-read",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).resolves.toMatchObject({ summary: "summary" });
    expect(session.compactCalls).toBe(1);
  });

  it("still rejects when the latest non-aborted assistant turn is unpaired", async () => {
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      activeMessages: [
        fauxAssistantMessage(fauxToolCall("read", {}, { id: "read-1" }), {
          stopReason: "aborted",
        }),
        fauxAssistantMessage(
          [
            fauxToolCall("read", {}, { id: "read-2" }),
            fauxToolCall("read", {}, { id: "read-3" }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toThrow("tool call is still in flight");
    expect(session.compactCalls).toBe(0);
  });

  it("passes a later external abort through and cancels the inline summary", async () => {
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const SessionClass = createSessionClass({
      legacyDisconnect: false,
      summaryGate,
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    const compaction = compactInlineAtTurnBoundary(session.sessionManager);
    await Promise.resolve();
    await session.abort();
    releaseSummary?.();

    await expect(compaction).rejects.toThrow("Compaction cancelled");
    expect(session.originalAbortCalls).toBe(1);
  });

  it("keeps captured sessions independent for nested-agent concurrency", async () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const parent = new SessionClass();
    const child = new SessionClass();
    parent._bindExtensionCore({});
    child._bindExtensionCore({});

    await Promise.all([
      compactInlineAtTurnBoundary(parent.sessionManager),
      compactInlineAtTurnBoundary(child.sessionManager),
    ]);

    expect(parent.originalAbortCalls).toBe(0);
    expect(child.originalAbortCalls).toBe(0);
    expect(parent.compactCalls).toBe(1);
    expect(child.compactCalls).toBe(1);
  });

  it("refreshes mutated state even when a post-compaction invariant fails", async () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    class PostMutationDriftSession extends SessionClass {
      invokeExpectedAbort = false;

      override async compact() {
        if (this.invokeExpectedAbort) await this.abort();
        this.sessionManager.appendCompaction();
        this.agent.state.messages = [
          { role: "user", content: "mutated-summary" },
        ];
        return {
          summary: "mutated-summary",
          firstKeptEntryId: "kept-1",
          tokensBefore: 42,
        };
      }
    }

    expect(
      installInlineCompactionAdapter({
        sessionClass: PostMutationDriftSession as never,
      }),
    ).toEqual({ supported: true });
    const session = new PostMutationDriftSession();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toThrow("quiesce hooks were not invoked");
    const next = await refreshNextTurn(session);

    expect(next.context.messages).toEqual([
      { role: "user", content: "mutated-summary" },
    ]);
  });

  it("ignores method-like text in literals when detecting compact shape", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    class TextBearingSession extends SessionClass {
      override async compact(customInstructions?: string) {
        const diagnostic =
          "this.abort() this._disconnectFromAgent() this._reconnectToAgent()";
        void diagnostic;
        const nestedDiagnostic = `outer ${`this.abort()`} tail`;
        void nestedDiagnostic;
        await this.abort();
        this.compactCalls += 1;
        this.customInstructions = customInstructions;
        this.sessionManager.appendCompaction();
        this.agent.state.messages = [{ role: "user", content: "summary" }];
        return {
          summary: "summary",
          firstKeptEntryId: "kept-1",
          tokensBefore: 42,
        };
      }
    }

    expect(
      installInlineCompactionAdapter({
        sessionClass: TextBearingSession as never,
      }),
    ).toEqual({ supported: true });
  });

  it("attempts every shadow restoration when one cleanup step fails", async () => {
    const SessionClass = createSessionClass({ legacyDisconnect: true });
    class CleanupFailureSession extends SessionClass {
      override async compact() {
        this._disconnectFromAgent();
        await this.abort();
        this._compactionAbortController = new AbortController();
        try {
          this.sessionManager.appendCompaction();
          this.agent.state.messages = [{ role: "user", content: "summary" }];
          Object.defineProperty(this, "abort", {
            configurable: false,
            writable: true,
            value: this.abort,
          });
          return {
            summary: "summary",
            firstKeptEntryId: "kept-1",
            tokensBefore: 42,
          };
        } finally {
          this._compactionAbortController = undefined;
          this._reconnectToAgent();
        }
      }
    }

    expect(
      installInlineCompactionAdapter({
        sessionClass: CleanupFailureSession as never,
      }),
    ).toEqual({ supported: true });
    const session = new CleanupFailureSession();
    session._bindExtensionCore({});

    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toThrow("restore");
    expect(Object.hasOwn(session, "_disconnectFromAgent")).toBe(false);
  });

  it("fails closed when Pi compact internals do not match a supported shape", async () => {
    class DriftedSession {
      sessionManager = {};
      _bindExtensionCore(): void {}
      async abort(): Promise<void> {}
      async compact(): Promise<void> {
        // Deliberately no abort/quiesce contract.
      }
    }

    const status = installInlineCompactionAdapter({
      sessionClass: DriftedSession as never,
    });
    const session = new DriftedSession();
    session._bindExtensionCore();

    expect(status.supported).toBe(false);
    expect(status.reason).toContain("unsupported AgentSession.compact() shape");
    await expect(
      compactInlineAtTurnBoundary(session.sessionManager),
    ).rejects.toBeInstanceOf(InlineCompactionUnavailableError);
  });

  it("parses Windows native host stack paths", () => {
    const windowsPath = String.raw`C:\Users\maple\node_modules\@earendil-works\pi-coding-agent\dist\runner.js`;

    expect(
      parseHostFramePaths(`Error\n    at run (${windowsPath}:12:34)`),
    ).toEqual([windowsPath]);
  });

  it("patches the bundled CLI AgentSession identity", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "blackhole-bundled-host-"),
    );
    const packageRoot = join(
      fixtureRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const dist = join(packageRoot, "dist");
    const chunks = join(dist, "bundle", "chunks");
    const cli = join(dist, "bundle", "cli.js");
    const runtimeChunk = join(chunks, "runtime.js");
    const sessionSource = `export class AgentSession {
  constructor() {
    this.agent = { state: { messages: [] } };
    this.sessionManager = {
      buildSessionContext: () => ({ messages: [] }),
      appendCompaction: () => {},
    };
  }
  async abort() {}
  _bindExtensionCore() {}
  async compact() {
    await this.abort();
    this.sessionManager.appendCompaction();
    this.agent.state.messages = [];
    return { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1 };
  }
}`;

    try {
      await mkdir(chunks, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          type: "module",
        }),
      );
      await writeFile(join(dist, "index.js"), sessionSource);
      await writeFile(
        runtimeChunk,
        `${sessionSource}\nexport function main() {}`,
      );
      await writeFile(
        cli,
        '#!/usr/bin/env node\nimport{main}from"./chunks/runtime.js";main();\n',
      );

      const bundledModule = (await import(
        pathToFileURL(runtimeChunk).href
      )) as {
        AgentSession: new () => {
          agent: { state: { messages: unknown[] } };
          sessionManager: object;
          _bindExtensionCore(runner: unknown): void;
        };
      };
      const originalBind =
        bundledModule.AgentSession.prototype._bindExtensionCore;

      await expect(
        installHostInlineCompactionAdapter({ entrypoint: cli, stack: "" }),
      ).resolves.toEqual({ supported: true });
      expect(bundledModule.AgentSession.prototype._bindExtensionCore).not.toBe(
        originalBind,
      );

      const session = new bundledModule.AgentSession();
      session._bindExtensionCore({});
      await expect(
        compactInlineAtTurnBoundary(session.sessionManager),
      ).resolves.toMatchObject({ summary: "summary" });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("patches every independently loaded host AgentSession identity", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "blackhole-host-identities-"),
    );
    const makeHostPackage = async (name: string) => {
      const packageRoot = join(
        fixtureRoot,
        name,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      const dist = join(packageRoot, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          type: "module",
        }),
      );
      await writeFile(
        join(dist, "index.js"),
        `export class AgentSession {
  async abort() {}
  _bindExtensionCore() {}
  async compact() {
    await this.abort();
    this.sessionManager.appendCompaction();
    this.agent.state.messages = [];
    return { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1 };
  }
}`,
      );
      const frame = join(dist, "frame.js");
      const cli = join(dist, "cli.js");
      await Promise.all([writeFile(frame, ""), writeFile(cli, "")]);
      return { packageRoot, frame, cli };
    };

    try {
      const [first, second] = await Promise.all([
        makeHostPackage("first"),
        makeHostPackage("second"),
      ]);
      const modules = await Promise.all(
        [first, second].map(
          async ({ packageRoot }) =>
            (await import(
              pathToFileURL(join(packageRoot, "dist", "index.js")).href
            )) as {
              AgentSession: { prototype: { _bindExtensionCore: unknown } };
            },
        ),
      );
      const originalBinds = modules.map(
        ({ AgentSession: SessionClass }) =>
          SessionClass.prototype._bindExtensionCore,
      );

      await expect(
        installHostInlineCompactionAdapter({
          entrypoint: second.cli,
          stack: `Error\n    at first (${first.frame}:1:1)`,
        }),
      ).resolves.toEqual({ supported: true });

      for (const [index, { AgentSession: SessionClass }] of modules.entries()) {
        expect(SessionClass.prototype._bindExtensionCore).not.toBe(
          originalBinds[index],
        );
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the host Pi module identity cannot be resolved", async () => {
    const status = await installHostInlineCompactionAdapter({
      entrypoint: join(process.cwd(), "not-a-pi-entrypoint.js"),
      stack: "",
    });

    expect(status.supported).toBe(false);
    expect(status.reason).toContain("host AgentSession module");
  });

  it("recognizes the installed Pi compact implementation", () => {
    expect(installInlineCompactionAdapter()).toEqual({ supported: true });
  });

  it("continues through inline compaction inside a real Pi AgentSession run", async () => {
    expect(installInlineCompactionAdapter()).toEqual({ supported: true });

    const summaryStarted = createDeferred();
    const releaseSummary = createDeferred();
    const nextRequestStarted = createDeferred();
    const releaseFinalResponse = createDeferred();
    const parameters = Type.Object({});
    const tool: AgentTool<typeof parameters> = {
      name: "echo",
      label: "Echo",
      description: "Return a deterministic result",
      parameters,
      execute: async () => ({
        content: [{ type: "text", text: "tool-result" }],
        details: {},
      }),
    };
    const harness = await createPiAgentSessionHarness([tool]);
    let promptPromise: Promise<void> | undefined;

    try {
      harness.sessionManager.appendMessage({
        role: "user",
        content: `old-user-1 ${"x".repeat(5_000)}`,
        timestamp: 1,
      });
      harness.sessionManager.appendMessage(
        fauxAssistantMessage("old-assistant-1", { timestamp: 2 }),
      );
      harness.sessionManager.appendMessage({
        role: "user",
        content: `old-user-2 ${"y".repeat(5_000)}`,
        timestamp: 3,
      });
      harness.sessionManager.appendMessage(
        fauxAssistantMessage("old-assistant-2", { timestamp: 4 }),
      );
      harness.agent.state.messages =
        harness.sessionManager.buildSessionContext().messages;

      let nextRequestMessages: Context["messages"] | undefined;
      harness.setResponses([
        fauxAssistantMessage(fauxToolCall("echo", {}, { id: "tool-1" }), {
          stopReason: "toolUse",
        }),
        async () => {
          summaryStarted.release();
          await releaseSummary.promise;
          return fauxAssistantMessage("COMPACTED-SUMMARY");
        },
        async (context) => {
          nextRequestMessages = context.messages;
          nextRequestStarted.release();
          await releaseFinalResponse.promise;
          return fauxAssistantMessage("finished");
        },
      ]);

      let compacted = false;
      let activeRunSignal: AbortSignal | undefined;
      let compactionError: unknown;
      harness.agent.subscribe(async (event, signal) => {
        if (event.type !== "turn_end" || compacted) return;
        compacted = true;
        activeRunSignal = signal;
        try {
          await compactInlineAtTurnBoundary(harness.sessionManager);
          expect(signal.aborted).toBe(false);
        } catch (error) {
          compactionError = error;
          throw error;
        }
      });

      let promptSettled = false;
      promptPromise = harness.session
        .prompt("use the echo tool and then finish")
        .finally(() => {
          promptSettled = true;
        });

      await Promise.race([
        summaryStarted.promise,
        promptPromise.then(() => {
          throw new Error(
            `prompt settled before compaction summary started: ${String(compactionError)}; messages=${JSON.stringify(harness.session.messages)}`,
          );
        }),
      ]);
      expect(promptSettled).toBe(false);
      expect(harness.session.isStreaming).toBe(true);
      expect(activeRunSignal?.aborted).toBe(false);

      releaseSummary.release();
      await Promise.race([
        nextRequestStarted.promise,
        promptPromise.then(() => {
          throw new Error("prompt settled before the post-compaction request");
        }),
      ]);
      expect(promptSettled).toBe(false);
      expect(activeRunSignal?.aborted).toBe(false);

      const compactedMessages =
        harness.sessionManager.buildSessionContext().messages;
      expect(nextRequestMessages).toEqual(convertToLlm(compactedMessages));
      expect(JSON.stringify(nextRequestMessages)).toContain(
        "COMPACTED-SUMMARY",
      );
      expect(JSON.stringify(nextRequestMessages)).not.toContain("old-user-1");

      releaseFinalResponse.release();
      await promptPromise;
      expect(promptSettled).toBe(true);
      expect(harness.session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
    } finally {
      releaseSummary.release();
      releaseFinalResponse.release();
      await promptPromise?.catch(() => undefined);
      harness.cleanup();
    }
  });

  it("installs idempotently across extension reloads", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    const originalBind = SessionClass.prototype._bindExtensionCore;

    expect(
      installInlineCompactionAdapter({ sessionClass: SessionClass as never }),
    ).toEqual({ supported: true });
    const patchedBind = SessionClass.prototype._bindExtensionCore;
    expect(patchedBind).not.toBe(originalBind);

    expect(
      installInlineCompactionAdapter({ sessionClass: SessionClass as never }),
    ).toEqual({ supported: true });
    expect(SessionClass.prototype._bindExtensionCore).toBe(patchedBind);
  });
});
