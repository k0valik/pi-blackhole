import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai/compat";
import type {
  CompactionEntry,
  CompactionResult,
  ExtensionHandler,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import {
  compactInlineAtTurnBoundary,
  getCapturedCompactionSettings,
  getPrepareCompactionStatus,
  InlineCompactionUnavailableError,
  installHostInlineCompactionAdapter,
  installInlineCompactionAdapter,
  isCompactionEligible,
  parseHostFramePaths,
} from "../src/om/inline-compaction.js";
import { createPiAgentSessionHarness } from "./fixtures/pi-agent-session.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { Runtime } from "../src/om/runtime.js";
import { registerCompactionTrigger } from "../src/om/compaction-trigger.js";

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

async function refreshNextTurn(session: InstanceType<ReturnType<typeof createSessionClass>>) {
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

const HOST_MANIFEST = JSON.stringify({
  name: "@earendil-works/pi-coding-agent",
  type: "module",
});

/** Minimal loadable AgentSession that satisfies Blackhole's compact shape guard. */
function hostSessionSource(summary: string): string {
  return `export class AgentSession {
  constructor() {
    this.agent = { state: { messages: [] } };
    this.sessionManager = {
      buildSessionContext: () => ({ messages: [] }),
      appendCompaction: () => {},
    };
    this.settingsManager = {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 }),
    };
  }
  async abort() {}
  _bindExtensionCore() {}
  async compact() {
    await this.abort();
    this.sessionManager.appendCompaction();
    this.agent.state.messages = [];
    return { summary: "${summary}", firstKeptEntryId: "kept", tokensBefore: 1 };
  }
}`;
}

interface HostFixture {
  barrel: string;
  cli: string;
  frame: string;
}

/**
 * Synthetic host package with a resolvable `prepareCompaction` module. The
 * `eligibleForCompaction` flag is the per-host sentinel: one host's helper
 * reports a preparation, the other's reports none.
 */
async function makeHostFixture(
  fixtureRoot: string,
  name: string,
  options: { eligibleForCompaction: boolean } | { prepareSource: string },
): Promise<HostFixture> {
  const packageRoot = join(fixtureRoot, name, "node_modules", "@earendil-works", "pi-coding-agent");
  const dist = join(packageRoot, "dist");
  await mkdir(join(dist, "core", "compaction"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
  await writeFile(join(dist, "index.js"), hostSessionSource(`${name}-summary`));
  const prepareSource =
    "prepareSource" in options
      ? options.prepareSource
      : options.eligibleForCompaction
        ? 'export function prepareCompaction(entries) { return { firstKeptEntryId: entries[0]?.id ?? "entry-1" }; }\n'
        : "export function prepareCompaction() { return undefined; }\n";
  await writeFile(join(dist, "core", "compaction", "index.js"), prepareSource);
  const cli = join(dist, "cli.js");
  const frame = join(dist, "frame.js");
  await Promise.all([writeFile(cli, ""), writeFile(frame, "")]);
  return { barrel: join(dist, "index.js"), cli, frame };
}

interface FixtureSessionClass {
  new (): {
    _bindExtensionCore(runner: unknown): void;
    sessionManager: object;
  };
}

/**
 * Synthetic session whose `compact()` reports its own label. Instances take an
 * explicit manager so tests can model Pi reusing one manager for a replacement
 * session and re-installing an adapter across a reload.
 */
function createSharedManagerSessionClass() {
  return class SharedManagerSession {
    agent = { state: { messages: [] as unknown[] } };
    _compactionAbortController: AbortController | undefined;
    settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20_000,
      }),
    };
    sessionManager: {
      buildSessionContext(): { messages: unknown[] };
      appendCompaction(): void;
    };

    constructor(label: string, sessionManager: SharedManagerSession["sessionManager"]) {
      this.label = label;
      this.sessionManager = sessionManager;
    }

    label: string;

    async abort(): Promise<void> {}

    _bindExtensionCore(runner: unknown): void {
      void runner;
    }

    async compact(): Promise<CompactionResult> {
      await this.abort();
      this._compactionAbortController = new AbortController();
      this.sessionManager.appendCompaction();
      this.agent.state.messages = [];
      return { summary: this.label, firstKeptEntryId: "kept", tokensBefore: 1 };
    }
  };
}

describe("Blackhole inline compaction adapter", () => {
  it.each([
    ["Pi 0.81 legacy disconnect shape", true],
    ["Pi 0.84 connected-listener shape", false],
  ])("compacts without aborting the active run on %s", async (_label, legacyDisconnect) => {
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
  });

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
          content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
        },
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toThrow(
      "tool call is still in flight",
    );
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
      summary: "summary",
    });
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toThrow(
      "tool call is still in flight",
    );
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
      summary: "summary",
    });
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
      summary: "summary",
    });
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
          [fauxToolCall("read", {}, { id: "read-2" }), fauxToolCall("read", {}, { id: "read-3" })],
          { stopReason: "toolUse" },
        ),
      ],
    });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    session._bindExtensionCore({});

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toThrow(
      "tool call is still in flight",
    );
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
        this.agent.state.messages = [{ role: "user", content: "mutated-summary" }];
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toThrow(
      "quiesce hooks were not invoked",
    );
    const next = await refreshNextTurn(session);

    expect(next.context.messages).toEqual([{ role: "user", content: "mutated-summary" }]);
  });

  it("ignores method-like text in literals when detecting compact shape", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    class TextBearingSession extends SessionClass {
      override async compact(customInstructions?: string) {
        const diagnostic = "this.abort() this._disconnectFromAgent() this._reconnectToAgent()";
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

    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toThrow("restore");
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
    await expect(compactInlineAtTurnBoundary(session.sessionManager)).rejects.toBeInstanceOf(
      InlineCompactionUnavailableError,
    );
  });

  it("parses Windows native host stack paths", () => {
    const windowsPath = String.raw`C:\Users\maple\node_modules\@earendil-works\pi-coding-agent\dist\runner.js`;

    expect(parseHostFramePaths(`Error\n    at run (${windowsPath}:12:34)`)).toEqual([windowsPath]);
  });

  it.each(["direct import", "createRequire bootstrap"])(
    "patches the bundled CLI AgentSession identity through %s",
    async (launcher) => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-bundled-host-"));
      const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
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
        await writeFile(runtimeChunk, `${sessionSource}\nexport function main() {}`);
        const runtimeSource = 'import{main}from"./chunks/runtime.js";main();\n';
        if (launcher === "createRequire bootstrap") {
          await writeFile(
            join(dist, "bundle", "cli-runtime.js"),
            'throw new Error("discovery must not execute the CLI runtime");\n' + runtimeSource,
          );
          await writeFile(
            cli,
            '#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from "node:module";\n' +
              'enableCompileCache();\ncreateRequire(import.meta.url)("./cli-runtime.js");\n',
          );
        } else {
          await writeFile(cli, runtimeSource);
        }

        const bundledModule = (await import(pathToFileURL(runtimeChunk).href)) as {
          AgentSession: new () => {
            agent: { state: { messages: unknown[] } };
            sessionManager: object;
            _bindExtensionCore(runner: unknown): void;
          };
        };
        const originalBind = bundledModule.AgentSession.prototype._bindExtensionCore;

        await expect(
          installHostInlineCompactionAdapter({ entrypoint: cli, stack: "" }),
        ).resolves.toEqual({ supported: true });
        expect(bundledModule.AgentSession.prototype._bindExtensionCore).not.toBe(originalBind);

        const session = new bundledModule.AgentSession();
        session._bindExtensionCore({});
        await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
          summary: "summary",
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "outside package"])(
    "falls back to the root barrel when a createRequire bootstrap is %s",
    async (kind) => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-bootstrap-fallback-"));
      const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
      const dist = join(packageRoot, "dist");
      const chunks = join(dist, "bundle", "chunks");
      const runtimeChunk = join(chunks, "runtime.js");
      const cli = join(dist, "bundle", "cli.js");
      try {
        await mkdir(chunks, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
        await writeFile(join(dist, "index.js"), hostSessionSource("bootstrap-fallback"));
        await writeFile(
          runtimeChunk,
          `${hostSessionSource("wrong-host")}\nexport function main() {}\n`,
        );
        if (kind === "outside package") {
          await writeFile(
            join(packageRoot, "..", "foreign-runtime.js"),
            'import { main } from "./pi-coding-agent/dist/bundle/chunks/runtime.js"; main();\n',
          );
        }
        const specifier = kind === "missing" ? "./missing.js" : "../../../foreign-runtime.js";
        await writeFile(
          cli,
          `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)(${JSON.stringify(specifier)});\n`,
        );
        const bundled = (await import(pathToFileURL(runtimeChunk).href)) as {
          AgentSession: FixtureSessionClass;
        };
        const originalBind = bundled.AgentSession.prototype._bindExtensionCore;
        await expect(
          installHostInlineCompactionAdapter({ entrypoint: cli, stack: "" }),
        ).resolves.toEqual({ supported: true });
        expect(bundled.AgentSession.prototype._bindExtensionCore).toBe(originalBind);
        const barrel = (await import(pathToFileURL(join(dist, "index.js")).href)) as {
          AgentSession: FixtureSessionClass;
        };
        const session = new barrel.AgentSession();
        session._bindExtensionCore({});
        await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
          summary: "bootstrap-fallback",
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("falls back to a root's dist barrel when its fast candidate lacks AgentSession", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-unbundled-host-"));
    const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const dist = join(packageRoot, "dist");
    try {
      await mkdir(dist, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
      // `dist/cli.js` is pi's unbundled CLI shim: it imports `main` from
      // `dist/main.js`, which is not the module barrel and exports no AgentSession.
      await writeFile(join(dist, "main.js"), "export async function main() {}\n");
      await writeFile(join(dist, "index.js"), hostSessionSource("barrel-summary"));
      await writeFile(
        join(dist, "cli.js"),
        '#!/usr/bin/env node\nimport { main } from "./main.js";\nvoid main();\n',
      );

      const barrel = (await import(pathToFileURL(join(dist, "index.js")).href)) as {
        AgentSession: new () => {
          _bindExtensionCore(runner: unknown): void;
          sessionManager: object;
        };
      };
      const originalBind = barrel.AgentSession.prototype._bindExtensionCore;

      await expect(
        installHostInlineCompactionAdapter({ entrypoint: join(dist, "cli.js"), stack: "" }),
      ).resolves.toEqual({ supported: true });
      expect(barrel.AgentSession.prototype._bindExtensionCore).not.toBe(originalBind);

      const session = new barrel.AgentSession();
      session._bindExtensionCore({});
      await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
        summary: "barrel-summary",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not import a root's dist barrel once its fast candidate is supported", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-fast-host-"));
    const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const dist = join(packageRoot, "dist");
    const chunks = join(dist, "bundle", "chunks");
    const barrelMarker = join(fixtureRoot, "barrel-imported.marker");
    try {
      await mkdir(chunks, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
      // An observable import sentinel plus a throwing body: the marker proves
      // the fast path never loaded this module, and the throw makes the failure
      // loud if a future change does load it.
      await writeFile(
        join(dist, "index.js"),
        `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync(${JSON.stringify(barrelMarker)}, "imported");\n` +
          'throw new Error("dist barrel must not be imported");\n',
      );
      await writeFile(
        join(chunks, "runtime.js"),
        `${hostSessionSource("fast-summary")}\nexport function main() {}\n`,
      );
      await writeFile(
        join(dist, "cli.js"),
        '#!/usr/bin/env node\nimport { main } from "./bundle/chunks/runtime.js";\nvoid main();\n',
      );

      await expect(
        installHostInlineCompactionAdapter({ entrypoint: join(dist, "cli.js"), stack: "" }),
      ).resolves.toEqual({ supported: true });
      expect(existsSync(barrelMarker)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "throws on import",
      'export function main() {}\nthrow new Error("fast candidate failed to load");\n',
    ],
    ["exports no AgentSession", "export function main() {}\n"],
  ])("falls back to the root barrel when the fast candidate %s", async (_kind, fastSource) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-fast-rejected-"));
    const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const dist = join(packageRoot, "dist");
    const chunks = join(dist, "bundle", "chunks");
    try {
      await mkdir(chunks, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
      // The fast candidate resolves but is rejected, so the root's modular
      // barrel must still be tried and must be the one that patches the session
      // used for compaction.
      await writeFile(join(chunks, "runtime.js"), fastSource);
      await writeFile(join(dist, "index.js"), `${hostSessionSource("barrel-after-rejection")}\n`);
      await writeFile(
        join(dist, "cli.js"),
        '#!/usr/bin/env node\nimport { main } from "./bundle/chunks/runtime.js";\nvoid main();\n',
      );

      const barrel = (await import(pathToFileURL(join(dist, "index.js")).href)) as {
        AgentSession: FixtureSessionClass;
      };

      await expect(
        installHostInlineCompactionAdapter({ entrypoint: join(dist, "cli.js"), stack: "" }),
      ).resolves.toEqual({ supported: true });

      const session = new barrel.AgentSession();
      session._bindExtensionCore({});
      await expect(compactInlineAtTurnBoundary(session.sessionManager)).resolves.toMatchObject({
        summary: "barrel-after-rejection",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accumulates every rejected candidate path in the discovery failure", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-rejected-host-"));
    const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const dist = join(packageRoot, "dist");
    try {
      await mkdir(dist, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
      await writeFile(join(dist, "main.js"), "export async function main() {}\n");
      await writeFile(join(dist, "index.js"), "export const notASession = 1;\n");
      await writeFile(
        join(dist, "cli.js"),
        '#!/usr/bin/env node\nimport { main } from "./main.js";\nvoid main();\n',
      );

      const status = await installHostInlineCompactionAdapter({
        entrypoint: join(dist, "cli.js"),
        stack: "",
      });

      expect(status.supported).toBe(false);
      expect(status.reason).toContain(`${join(dist, "main.js")}: AgentSession export missing`);
      expect(status.reason).toContain(`${join(dist, "index.js")}: AgentSession export missing`);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("binds each host's preparation helper to the sessions captured from that host", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-host-prepare-"));
    try {
      const ineligible = await makeHostFixture(fixtureRoot, "ineligible", {
        eligibleForCompaction: false,
      });
      const eligible = await makeHostFixture(fixtureRoot, "eligible", {
        eligibleForCompaction: true,
      });
      const ineligibleModule = (await import(pathToFileURL(ineligible.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };
      const eligibleModule = (await import(pathToFileURL(eligible.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };

      // Stack frame first, then entrypoint: the ineligible host resolves first.
      await expect(
        installHostInlineCompactionAdapter({
          entrypoint: eligible.cli,
          stack: `Error\n    at first (${ineligible.frame}:1:1)`,
        }),
      ).resolves.toEqual({ supported: true });

      const ineligibleSession = new ineligibleModule.AgentSession();
      ineligibleSession._bindExtensionCore({});
      const eligibleSession = new eligibleModule.AgentSession();
      eligibleSession._bindExtensionCore({});

      expect(isCompactionEligible(ineligibleSession.sessionManager, [])).toBe(false);
      expect(isCompactionEligible(eligibleSession.sessionManager, [])).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("binds host helpers correctly when the entrypoint host resolves first", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-host-prepare-reversed-"));
    try {
      const eligible = await makeHostFixture(fixtureRoot, "eligible", {
        eligibleForCompaction: true,
      });
      const ineligible = await makeHostFixture(fixtureRoot, "ineligible", {
        eligibleForCompaction: false,
      });
      const eligibleModule = (await import(pathToFileURL(eligible.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };
      const ineligibleModule = (await import(pathToFileURL(ineligible.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };

      // Entrypoint host (ineligible) resolves second; the stack host resolves first.
      await expect(
        installHostInlineCompactionAdapter({
          entrypoint: ineligible.cli,
          stack: `Error\n    at first (${eligible.frame}:1:1)`,
        }),
      ).resolves.toEqual({ supported: true });

      const eligibleSession = new eligibleModule.AgentSession();
      eligibleSession._bindExtensionCore({});
      const ineligibleSession = new ineligibleModule.AgentSession();
      ineligibleSession._bindExtensionCore({});

      expect(isCompactionEligible(ineligibleSession.sessionManager, [])).toBe(false);
      expect(isCompactionEligible(eligibleSession.sessionManager, [])).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("patches every independently loaded host AgentSession identity", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-host-identities-"));
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
            (await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href)) as {
              AgentSession: { prototype: { _bindExtensionCore: unknown } };
            },
        ),
      );
      const originalBinds = modules.map(
        ({ AgentSession: SessionClass }) => SessionClass.prototype._bindExtensionCore,
      );

      await expect(
        installHostInlineCompactionAdapter({
          entrypoint: second.cli,
          stack: `Error\n    at first (${first.frame}:1:1)`,
        }),
      ).resolves.toEqual({ supported: true });

      for (const [index, { AgentSession: SessionClass }] of modules.entries()) {
        expect(SessionClass.prototype._bindExtensionCore).not.toBe(originalBinds[index]);
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

  it("uses the owning host helper with the supplied compaction settings", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-host-settings-"));
    try {
      const gated = await makeHostFixture(fixtureRoot, "gated", {
        prepareSource:
          "export function prepareCompaction(entries, settings) {\n" +
          "  if (!settings || settings.enabled === false) return undefined;\n" +
          '  return { firstKeptEntryId: entries[0]?.id ?? "entry-1" };\n' +
          "}\n",
      });
      const none = await makeHostFixture(fixtureRoot, "none", {
        prepareSource: "export function prepareCompaction() { return undefined; }\n",
      });
      const gatedModule = (await import(pathToFileURL(gated.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };
      const noneModule = (await import(pathToFileURL(none.barrel).href)) as {
        AgentSession: FixtureSessionClass;
      };

      await expect(
        installHostInlineCompactionAdapter({
          entrypoint: none.cli,
          stack: `Error\n    at first (${gated.frame}:1:1)`,
        }),
      ).resolves.toEqual({ supported: true });

      const gatedSession = new gatedModule.AgentSession();
      gatedSession._bindExtensionCore({});
      const noneSession = new noneModule.AgentSession();
      noneSession._bindExtensionCore({});

      const enabled = { enabled: true, reserveTokens: 1000, keepRecentTokens: 20_000 };
      const disabled = { enabled: false, reserveTokens: 1000, keepRecentTokens: 20_000 };
      // Same run supplies both settings values: only the owning host's helper
      // decides, and it must receive the caller's settings unchanged.
      expect(isCompactionEligible(gatedSession.sessionManager, [], enabled)).toBe(true);
      expect(isCompactionEligible(gatedSession.sessionManager, [], disabled)).toBe(false);
      expect(isCompactionEligible(noneSession.sessionManager, [], enabled)).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("compacts the replacement session that reuses a captured session manager", async () => {
    const SharedManagerSession = createSharedManagerSessionClass();
    const manager = {
      buildSessionContext: () => ({ messages: [] as unknown[] }),
      appendCompaction: vi.fn(),
    };
    expect(
      installInlineCompactionAdapter({
        sessionClass: SharedManagerSession,
        hostPrepareCompaction: () => ({}),
      }),
    ).toEqual({ supported: true });

    new SharedManagerSession("previous", manager)._bindExtensionCore({});
    new SharedManagerSession("replacement", manager)._bindExtensionCore({});

    await expect(compactInlineAtTurnBoundary(manager)).resolves.toMatchObject({
      summary: "replacement",
    });
  });

  it("uses the refreshed host helper after the adapter is reinstalled", async () => {
    const RefreshableSession = createSharedManagerSessionClass();
    const manager = {
      buildSessionContext: () => ({ messages: [] as unknown[] }),
      appendCompaction: vi.fn(),
    };
    installInlineCompactionAdapter({
      sessionClass: RefreshableSession,
      hostPrepareCompaction: () => undefined,
    });
    const session = new RefreshableSession("reloaded", manager);
    session._bindExtensionCore({});

    expect(isCompactionEligible(manager, [])).toBe(false);

    // A reload re-installs the adapter with the host's current helper.
    installInlineCompactionAdapter({
      sessionClass: RefreshableSession,
      hostPrepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    });
    session._bindExtensionCore({});

    expect(isCompactionEligible(manager, [])).toBe(true);
  });

  it("reports preparation capability from the session's own host", async () => {
    const WithHelper = createSharedManagerSessionClass();
    const WithoutHelper = createSharedManagerSessionClass();
    const withHelperManager = {
      buildSessionContext: () => ({ messages: [] as unknown[] }),
      appendCompaction: vi.fn(),
    };
    const withoutHelperManager = {
      buildSessionContext: () => ({ messages: [] as unknown[] }),
      appendCompaction: vi.fn(),
    };
    installInlineCompactionAdapter({
      sessionClass: WithHelper,
      hostPrepareCompaction: () => ({ firstKeptEntryId: "kept" }),
    });
    installInlineCompactionAdapter({
      sessionClass: WithoutHelper,
      hostPrepareCompaction: undefined,
    });

    new WithHelper("with-helper", withHelperManager)._bindExtensionCore({});
    new WithoutHelper("without-helper", withoutHelperManager)._bindExtensionCore({});

    expect(getPrepareCompactionStatus(withHelperManager)).toEqual({ resolved: true });
    expect(getPrepareCompactionStatus(withoutHelperManager)).toEqual({ resolved: false });
    // The shared registry entry still describes whichever host resolved first;
    // it must not stand in for a host that exposes no helper of its own.
    expect(getPrepareCompactionStatus().resolved).toBe(true);
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
      harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

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
      promptPromise = harness.session.prompt("use the echo tool and then finish").finally(() => {
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

      const compactedMessages = harness.sessionManager.buildSessionContext().messages;
      expect(nextRequestMessages).toEqual(convertToLlm(compactedMessages));
      expect(JSON.stringify(nextRequestMessages)).toContain("COMPACTED-SUMMARY");
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

    expect(installInlineCompactionAdapter({ sessionClass: SessionClass as never })).toEqual({
      supported: true,
    });
    const patchedBind = SessionClass.prototype._bindExtensionCore;
    expect(patchedBind).not.toBe(originalBind);

    expect(installInlineCompactionAdapter({ sessionClass: SessionClass as never })).toEqual({
      supported: true,
    });
    expect(SessionClass.prototype._bindExtensionCore).toBe(patchedBind);
  });

  it("captures compaction settings from the session settingsManager", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({ sessionClass: SessionClass as never });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 2048,
        keepRecentTokens: 5000,
      }),
    };
    session._bindExtensionCore({});

    const settings = getCapturedCompactionSettings(session.sessionManager);
    expect(settings).toEqual({
      enabled: true,
      reserveTokens: 2048,
      keepRecentTokens: 5000,
    });
  });

  it("returns false from isCompactionEligible when prepareCompaction yields undefined (ineligible)", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({
      sessionClass: SessionClass as never,
      prepareCompaction: () => undefined,
    });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20000,
      }),
    };
    session._bindExtensionCore({});

    expect(isCompactionEligible(session.sessionManager, [])).toBe(false);
  });

  it("returns true from isCompactionEligible when prepareCompaction returns a preparation (eligible)", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({
      sessionClass: SessionClass as never,
      prepareCompaction: () => ({ firstKeptEntryId: "entry-1" }),
    });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20000,
      }),
    };
    session._bindExtensionCore({});

    expect(isCompactionEligible(session.sessionManager, [])).toBe(true);
  });

  it("fails open (returns true) from isCompactionEligible when prepareCompaction throws", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({
      sessionClass: SessionClass as never,
      prepareCompaction: () => {
        throw new Error("unexpected error");
      },
    });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20000,
      }),
    };
    session._bindExtensionCore({});

    expect(isCompactionEligible(session.sessionManager, [])).toBe(true);
  });

  it("fails open (returns true) from isCompactionEligible when prepareCompaction is unavailable", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({
      sessionClass: SessionClass as never,
      prepareCompaction: undefined,
    });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 1000,
        keepRecentTokens: 20000,
      }),
    };
    session._bindExtensionCore({});

    expect(isCompactionEligible(session.sessionManager, [])).toBe(true);
  });

  it("fails open (returns true) from isCompactionEligible when settings are unavailable (session not captured)", () => {
    installInlineCompactionAdapter({
      prepareCompaction: () => undefined,
    });
    const uncapturedSessionManager = { buildSessionContext: () => ({ messages: [] }) };
    expect(isCompactionEligible(uncapturedSessionManager, [])).toBe(true);
  });

  it("fails open (returns true) from isCompactionEligible when settingsManager getter throws", () => {
    const SessionClass = createSessionClass({ legacyDisconnect: false });
    installInlineCompactionAdapter({
      sessionClass: SessionClass as never,
      prepareCompaction: () => undefined,
    });
    const session = new SessionClass();
    (session as any).settingsManager = {
      getCompactionSettings: () => {
        throw new Error("corrupt settings");
      },
    };
    session._bindExtensionCore({});

    expect(isCompactionEligible(session.sessionManager, [])).toBe(true);
  });

  it("resolves prepareCompaction from the host package root via installHostInlineCompactionAdapter", async () => {
    const cliPath = join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    const status = await installHostInlineCompactionAdapter({
      entrypoint: cliPath,
      stack: "",
    });
    expect(status.supported).toBe(true);
    const prepareStatus = getPrepareCompactionStatus();
    expect(prepareStatus.resolved).toBe(true);
    expect(prepareStatus.source).toContain("compaction");
  });

  it("resolves the installed host through its unbundled CLI shim entrypoint", async () => {
    const cliPath = join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );

    expect(existsSync(cliPath)).toBe(true);
    await expect(
      installHostInlineCompactionAdapter({ entrypoint: cliPath, stack: "" }),
    ).resolves.toEqual({ supported: true });
  });

  interface TurnEndScenarioOptions {
    /** Mirrors extension startup: installs the adapter before any session exists. */
    install: () => void | Promise<void>;
    compactAfterTokens?: number;
  }

  /**
   * Drives one real AgentSession run through the registered turn_end trigger:
   * an active tool turn crosses the threshold, compaction must complete before
   * the next provider request and must not abort the run.
   */
  async function runTurnEndCompactionScenario(options: TurnEndScenarioOptions): Promise<void> {
    await options.install();

    const turnEndHandlers: ExtensionHandler<TurnEndEvent>[] = [];
    const runtime = new Runtime();
    runtime.config = {
      ...runtime.config,
      compaction: "auto",
      compactionEngine: "blackhole",
      passive: false,
      noAutoCompact: false,
      overrideDefaultCompaction: true,
      memory: true,
      midRunCompaction: "resume",
      compactAfterTokens: options.compactAfterTokens ?? 1,
    };
    runtime.ensureConfig = vi.fn();
    runtime.resetInfoGate = vi.fn();
    runtime.tryEmitInfo = vi.fn();
    runtime.compactInFlight = false;
    runtime.autoCompactionController = null;
    runtime.midRunCompactionRetry = { failures: 0, retryAfter: 0 };
    runtime.inlineCompactionAdapterStatus = undefined;
    runtime.inlineCompactionWarningEmitted = false;

    registerCompactionTrigger(
      createExtensionApiDouble({ turnEndHandlers }),
      runtime,
      compactInlineAtTurnBoundary,
    );
    const turnEndHandler = turnEndHandlers[0];
    if (typeof turnEndHandler !== "function") {
      throw new Error("registerCompactionTrigger did not register a turn_end handler");
    }

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
      harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

      const requestContexts: Context["messages"][] = [];
      let nextRequestMessages: Context["messages"] | undefined;
      harness.setResponses([
        async (context) => {
          requestContexts.push(context.messages);
          return fauxAssistantMessage(fauxToolCall("echo", {}, { id: "tool-1" }), {
            stopReason: "toolUse",
          });
        },
        async (context) => {
          requestContexts.push(context.messages);
          summaryStarted.release();
          await releaseSummary.promise;
          return fauxAssistantMessage("COMPACTED-SUMMARY");
        },
        async (context) => {
          requestContexts.push(context.messages);
          nextRequestMessages = context.messages;
          nextRequestStarted.release();
          await releaseFinalResponse.promise;
          return fauxAssistantMessage("finished");
        },
      ]);

      const savedCompactions: CompactionResult[] = [];
      harness.session.subscribe((event) => {
        if (event.type === "compaction_end" && event.result) savedCompactions.push(event.result);
      });

      let activeRunSignal: AbortSignal | undefined;
      let handlerError: unknown;
      let turnIndex = 0;
      harness.agent.subscribe(async (event, signal) => {
        if (event.type !== "turn_end") return;
        activeRunSignal = signal;
        try {
          await turnEndHandler(
            { ...event, turnIndex: turnIndex++ },
            {
              ...harness.session.extensionRunner.createContext(),
              signal,
            },
          );
        } catch (error) {
          handlerError = error;
          throw error;
        }
      });

      let promptSettled = false;
      promptPromise = harness.session.prompt("use the echo tool and then finish").finally(() => {
        promptSettled = true;
      });

      await Promise.race([
        summaryStarted.promise,
        promptPromise.then(() => {
          throw new Error(
            `prompt settled before the trigger compaction summary started: ${String(handlerError)}`,
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
          throw new Error(
            `prompt settled before the post-compaction request: ${String(handlerError)}`,
          );
        }),
      ]);
      expect(handlerError).toBeUndefined();
      expect(promptSettled).toBe(false);
      expect(activeRunSignal?.aborted).toBe(false);
      expect(runtime.compactInFlight).toBe(false);
      expect(savedCompactions).toHaveLength(1);

      // Persisted identity: one compaction entry exists in the branch, and the
      // context Pi keeps after it starts at the entry it retained.
      const persistedCompactions = harness.sessionManager
        .getBranch()
        .filter((entry): entry is CompactionEntry => entry.type === "compaction");
      expect(persistedCompactions).toHaveLength(1);
      expect(persistedCompactions[0]?.summary).toBe(savedCompactions[0]?.summary);
      expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toContain(
        persistedCompactions[0]?.firstKeptEntryId,
      );

      const compactedMessages = harness.sessionManager.buildSessionContext().messages;
      expect(nextRequestMessages).toEqual(convertToLlm(compactedMessages));
      expect(JSON.stringify(nextRequestMessages)).toContain("COMPACTED-SUMMARY");
      expect(JSON.stringify(nextRequestMessages)).not.toContain("old-user-1");
      // Exactly one tool turn, one summarization request, one continuation —
      // a resubmitted prompt would need a fourth faux response.
      expect(requestContexts).toHaveLength(3);

      releaseFinalResponse.release();
      await promptPromise;
      expect(promptSettled).toBe(true);
      expect(savedCompactions).toHaveLength(1);
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
  }

  describe("turn_end compaction through a live agent run", () => {
    it("compacts with an injected host helper before the next provider request", async () => {
      // Eligibility is injected so this test exercises the trigger → adapter →
      // provider path rather than the host's prepareCompaction resolver.
      await runTurnEndCompactionScenario({
        install: () => {
          installInlineCompactionAdapter({
            prepareCompaction: () => ({ firstKeptEntryId: "entry-1" }),
          });
        },
      });
    });

    it("compacts when a discovered host layout supplies the AgentSession class", async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "blackhole-discovery-loop-"));
      const packageRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent");
      const dist = join(packageRoot, "dist");
      try {
        await mkdir(dist, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), HOST_MANIFEST);
        // The barrel re-exports the installed host's session class, so discovery
        // patches the same prototype the provider-loop harness instantiates.
        const hostBarrel = join(
          process.cwd(),
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "index.js",
        );
        await writeFile(
          join(dist, "index.js"),
          `export { AgentSession } from ${JSON.stringify(pathToFileURL(hostBarrel).href)};\n`,
        );
        await writeFile(join(dist, "cli.js"), "");

        await runTurnEndCompactionScenario({
          install: async () => {
            await expect(
              installHostInlineCompactionAdapter({ entrypoint: join(dist, "cli.js"), stack: "" }),
            ).resolves.toEqual({ supported: true });
          },
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });
  });
});
