import { AgentSession, type CompactionResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REGISTRY_KEY = Symbol.for("pi-blackhole:inline-compaction-adapter:v1");

interface TurnContextLike {
  messages: unknown[];
  [key: string]: unknown;
}

interface TurnLike {
  context: TurnContextLike;
}

interface NextTurnSnapshotLike {
  context?: TurnContextLike;
  [key: string]: unknown;
}

type PrepareNextTurn = (
  turn: TurnLike,
  signal: AbortSignal,
) => Promise<NextTurnSnapshotLike | undefined>;

interface AgentLike {
  state: { messages: unknown[] };
  prepareNextTurnWithContext?: PrepareNextTurn;
}

interface SessionManagerLike {
  buildSessionContext(): { messages: unknown[] };
}

interface PatchableSession {
  agent: AgentLike;
  sessionManager: SessionManagerLike;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  _bindExtensionCore(runner: unknown): unknown;
  _disconnectFromAgent?(): void;
  _reconnectToAgent?(): void;
  _compactionAbortController?: AbortController;
  _autoCompactionAbortController?: AbortController;
}

type PatchableSessionPrototype = Pick<
  PatchableSession,
  "abort" | "compact" | "_bindExtensionCore"
> &
  Partial<Pick<PatchableSession, "_disconnectFromAgent" | "_reconnectToAgent">>;

interface PatchableSessionClass {
  prototype: PatchableSessionPrototype;
}

interface CompactShape {
  disconnectsAgent: boolean;
}

interface InstalledAdapter {
  status: InlineCompactionAdapterStatus;
  originalCompact?: PatchableSession["compact"];
  shape?: CompactShape;
}

interface SessionRecord {
  session: PatchableSession;
  originalCompact: PatchableSession["compact"];
  shape: CompactShape;
}

interface AdapterRegistry {
  installs: WeakMap<object, InstalledAdapter>;
  sessions: WeakMap<object, SessionRecord>;
  refreshInstalled: WeakSet<object>;
  refreshPending: WeakSet<object>;
  compactionInFlight: WeakSet<object>;
  hostCandidateCount?: number;
  capturedSessionCount?: number;
}

export interface InlineCompactionAdapterStatus {
  supported: boolean;
  reason?: string;
}

export interface InlineCompactionInstallOptions {
  sessionClass?: PatchableSessionClass;
}

export interface HostInlineCompactionInstallOptions {
  entrypoint?: string;
  stack?: string;
}

export type InlineCompaction = (
  sessionManager: object,
  customInstructions?: string,
) => Promise<CompactionResult>;

export class InlineCompactionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InlineCompactionUnavailableError";
  }
}

function getRegistry(): AdapterRegistry {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = host[REGISTRY_KEY] as AdapterRegistry | undefined;
  if (existing) {
    existing.hostCandidateCount ??= 0;
    existing.capturedSessionCount ??= 0;
    return existing;
  }

  const registry: AdapterRegistry = {
    installs: new WeakMap(),
    sessions: new WeakMap(),
    refreshInstalled: new WeakSet(),
    refreshPending: new WeakSet(),
    compactionInFlight: new WeakSet(),
    hostCandidateCount: 0,
    capturedSessionCount: 0,
  };
  host[REGISTRY_KEY] = registry;
  return registry;
}

function maskNonCodeText(source: string): string {
  const masked = source.split("");
  const blank = (position: number) => {
    if (masked[position] !== "\n" && masked[position] !== "\r") {
      masked[position] = " ";
    }
  };

  const maskQuoted = (start: number, delimiter: string): number => {
    let index = start;
    blank(index++);
    while (index < source.length) {
      const value = source[index];
      blank(index++);
      if (value === "\\" && index < source.length) {
        blank(index++);
        continue;
      }
      if (value === delimiter) break;
    }
    return index;
  };

  const maskLineComment = (start: number): number => {
    let index = start;
    blank(index++);
    blank(index++);
    while (index < source.length && source[index] !== "\n") blank(index++);
    return index;
  };

  const maskBlockComment = (start: number): number => {
    let index = start;
    blank(index++);
    blank(index++);
    while (index < source.length) {
      const value = source[index];
      const next = source[index + 1];
      blank(index++);
      if (value === "*" && next === "/") {
        blank(index++);
        break;
      }
    }
    return index;
  };

  function maskTemplateExpression(start: number): number {
    let index = start;
    let braceDepth = 1;
    while (index < source.length && braceDepth > 0) {
      const current = source[index];
      const next = source[index + 1];
      if (current === '"' || current === "'") {
        index = maskQuoted(index, current);
        continue;
      }
      if (current === "`") {
        index = maskTemplate(index);
        continue;
      }
      if (current === "/" && next === "/") {
        index = maskLineComment(index);
        continue;
      }
      if (current === "/" && next === "*") {
        index = maskBlockComment(index);
        continue;
      }
      if (current === "{") braceDepth += 1;
      if (current === "}") braceDepth -= 1;
      blank(index++);
    }
    return index;
  }

  function maskTemplate(start: number): number {
    let index = start;
    blank(index++);
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];
      if (current === "\\") {
        blank(index++);
        if (index < source.length) blank(index++);
        continue;
      }
      if (current === "`") {
        blank(index++);
        break;
      }
      if (current === "$" && next === "{") {
        blank(index++);
        blank(index++);
        index = maskTemplateExpression(index);
        continue;
      }
      blank(index++);
    }
    return index;
  }

  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'") {
      index = maskQuoted(index, current);
      continue;
    }
    if (current === "`") {
      index = maskTemplate(index);
      continue;
    }
    if (current === "/" && next === "/") {
      index = maskLineComment(index);
      continue;
    }
    if (current === "/" && next === "*") {
      index = maskBlockComment(index);
      continue;
    }
    index += 1;
  }

  return masked.join("");
}

function countMethodCalls(source: string, method: string): number {
  const pattern = new RegExp(`this\\.${method}\\s*\\(\\s*\\)`, "g");
  return source.match(pattern)?.length ?? 0;
}

function detectCompactShape(prototype: PatchableSessionPrototype): CompactShape | string {
  if (typeof prototype.compact !== "function") {
    return "AgentSession.compact() is missing";
  }
  if (typeof prototype.abort !== "function") {
    return "AgentSession.abort() is missing";
  }
  if (typeof prototype._bindExtensionCore !== "function") {
    return "AgentSession._bindExtensionCore() is missing";
  }

  const source = maskNonCodeText(Function.prototype.toString.call(prototype.compact));
  const abortCalls = countMethodCalls(source, "abort");
  if (
    abortCalls !== 1 ||
    !source.includes("appendCompaction") ||
    !source.includes("agent.state.messages")
  ) {
    return "unsupported AgentSession.compact() shape";
  }

  const disconnectCalls = countMethodCalls(source, "_disconnectFromAgent");
  const reconnectCalls = countMethodCalls(source, "_reconnectToAgent");
  if (disconnectCalls === 0 && reconnectCalls === 0) {
    return { disconnectsAgent: false };
  }
  if (
    disconnectCalls === 1 &&
    reconnectCalls === 1 &&
    typeof prototype._disconnectFromAgent === "function" &&
    typeof prototype._reconnectToAgent === "function"
  ) {
    return { disconnectsAgent: true };
  }
  return "unsupported AgentSession disconnect/reconnect shape";
}

function shadowProperty(target: object, key: string, value: unknown): () => void {
  const record = target as Record<string, unknown>;
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: ownDescriptor?.enumerable ?? false,
    writable: true,
    value,
  });

  return () => {
    if (ownDescriptor) {
      Object.defineProperty(target, key, ownDescriptor);
    } else {
      delete record[key];
    }
  };
}

function installNextTurnRefresh(session: PatchableSession, registry: AdapterRegistry): void {
  const agent = session.agent;
  if (registry.refreshInstalled.has(agent)) return;

  const previous = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await previous?.call(agent, turn, signal);
    if (!registry.refreshPending.has(session)) return snapshot;

    registry.refreshPending.delete(session);
    const context = snapshot?.context ?? turn.context;
    return {
      ...snapshot,
      context: {
        ...context,
        messages: session.agent.state.messages.slice(),
      },
    };
  };
  registry.refreshInstalled.add(agent);
}

function registerSession(
  session: PatchableSession,
  installed: InstalledAdapter,
  registry: AdapterRegistry,
): void {
  if (!installed.originalCompact || !installed.shape) return;
  if (
    !session.sessionManager ||
    typeof session.sessionManager !== "object" ||
    typeof session.sessionManager.buildSessionContext !== "function"
  ) {
    return;
  }

  if (!registry.sessions.has(session.sessionManager)) {
    registry.capturedSessionCount = (registry.capturedSessionCount ?? 0) + 1;
  }
  registry.sessions.set(session.sessionManager, {
    session,
    originalCompact: installed.originalCompact,
    shape: installed.shape,
  });
  installNextTurnRefresh(session, registry);
}

function findPiPackageRoot(startPath: string): string | undefined {
  let current: string;
  try {
    current = dirname(realpathSync(startPath));
  } catch {
    return undefined;
  }

  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: string;
        };
        if (manifest.name === "@earendil-works/pi-coding-agent") return current;
      } catch {
        // Keep walking: an unrelated malformed package must not select a host.
      }
    }
    current = dirname(current);
  }
  return undefined;
}

export function parseHostFramePaths(stack: string): string[] {
  const paths: string[] = [];
  for (const line of stack.split("\n")) {
    const match = line.match(/\((.+):\d+:\d+\)\s*$/) ?? line.match(/\bat (.+):\d+:\d+\s*$/);
    if (!match?.[1]) continue;
    const rawPath = match[1].trim();
    const normalizedPath = rawPath.replaceAll("\\", "/");
    if (!normalizedPath.includes("@earendil-works/pi-coding-agent")) {
      continue;
    }
    if (
      !rawPath.startsWith("file://") &&
      !rawPath.startsWith("/") &&
      !rawPath.startsWith("\\\\") &&
      !/^[A-Za-z]:[\\/]/.test(rawPath)
    ) {
      continue;
    }
    try {
      paths.push(rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath);
    } catch {
      // Ignore malformed stack locations and continue to the CLI entrypoint.
    }
  }
  return paths;
}

function findBundledRuntimeModule(entrypoint: string, packageRoot: string): string | undefined {
  let resolvedEntrypoint: string;
  let source: string;
  try {
    resolvedEntrypoint = realpathSync(entrypoint);
    source = readFileSync(resolvedEntrypoint, "utf8");
  } catch {
    return undefined;
  }

  const namedImport = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namedImport)) {
    const names = match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
    const specifier = match[2];
    if (!names.includes("main") || !specifier.startsWith(".")) continue;

    try {
      const candidate = realpathSync(join(dirname(resolvedEntrypoint), specifier));
      if (findPiPackageRoot(candidate) === packageRoot) return candidate;
    } catch {
      // Keep searching other named imports before falling back to dist/index.js.
    }
  }

  return undefined;
}

export async function installHostInlineCompactionAdapter(
  options: HostInlineCompactionInstallOptions = {},
): Promise<InlineCompactionAdapterStatus> {
  const packageRoots = new Set<string>();
  const hostPaths = new Set<string>();
  const stack = options.stack ?? new Error().stack ?? "";
  for (const framePath of parseHostFramePaths(stack)) hostPaths.add(framePath);

  const entrypoint = options.entrypoint ?? process.argv[1];
  if (entrypoint) hostPaths.add(entrypoint);

  for (const hostPath of hostPaths) {
    const root = findPiPackageRoot(hostPath);
    if (root) packageRoots.add(root);
  }

  const modulePaths = new Set<string>();
  for (const packageRoot of packageRoots) {
    modulePaths.add(join(packageRoot, "dist", "index.js"));
    for (const hostPath of hostPaths) {
      if (findPiPackageRoot(hostPath) !== packageRoot) continue;
      const bundledRuntime = findBundledRuntimeModule(hostPath, packageRoot);
      if (bundledRuntime) modulePaths.add(bundledRuntime);
    }
  }
  getRegistry().hostCandidateCount = modulePaths.size;

  let supportedStatus: InlineCompactionAdapterStatus | undefined;
  const failureReasons: string[] = [];
  for (const modulePath of modulePaths) {
    try {
      const hostModule = (await import(pathToFileURL(modulePath).href)) as {
        AgentSession?: PatchableSessionClass;
      };
      if (!hostModule.AgentSession) {
        failureReasons.push(`${modulePath}: AgentSession export missing`);
        continue;
      }

      const status = installInlineCompactionAdapter({
        sessionClass: hostModule.AgentSession,
      });
      if (status.supported) supportedStatus ??= status;
      else failureReasons.push(`${modulePath}: ${status.reason ?? "unsupported"}`);
    } catch (error) {
      failureReasons.push(
        `${modulePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (supportedStatus) return supportedStatus;
  const details = failureReasons.length > 0 ? ` (${failureReasons.join("; ")})` : "";
  return {
    supported: false,
    reason:
      "Blackhole inline compaction is unavailable: host AgentSession module could not be resolved" +
      details,
  };
}

export function installInlineCompactionAdapter(
  options: InlineCompactionInstallOptions = {},
): InlineCompactionAdapterStatus {
  const sessionClass = options.sessionClass ?? (AgentSession as unknown as PatchableSessionClass);
  const prototype = sessionClass.prototype;
  const registry = getRegistry();
  const existing = registry.installs.get(prototype);
  if (existing) return existing.status;

  const shape = detectCompactShape(prototype);
  if (typeof shape === "string") {
    const status = { supported: false, reason: shape };
    registry.installs.set(prototype, { status });
    return status;
  }

  const originalCompact = prototype.compact;
  const originalBindExtensionCore = prototype._bindExtensionCore;
  const installed: InstalledAdapter = {
    status: { supported: true },
    originalCompact,
    shape,
  };

  prototype._bindExtensionCore = function patchedBindExtensionCore(
    this: PatchableSession,
    runner: unknown,
  ): unknown {
    registerSession(this, installed, registry);
    return originalBindExtensionCore.call(this, runner);
  };

  registry.installs.set(prototype, installed);
  return installed.status;
}

function getToolCallId(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const value = block as { type?: unknown; id?: unknown };
  return value.type === "toolCall" && typeof value.id === "string" ? value.id : undefined;
}

function hasTrailingUnpairedToolCall(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;

    const value = message as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
    };
    if (value.role !== "assistant") continue;

    // A non-array content means the model produced a text response and moved on;
    // any earlier unpaired tool calls were superseded by this turn.
    if (!Array.isArray(value.content)) return false;

    // Skip aborted/errored turns — Pi drops these from API replay and excludes
    // their tool calls from pending tracking (see pi-ai `transform-messages.js`).
    // Only the latest *successful* assistant tool batch can still be in flight.
    const stopReason = value.stopReason;
    if (stopReason === "error" || stopReason === "aborted") continue;

    const pending = new Set<string>();
    for (const block of value.content) {
      const id = getToolCallId(block);
      if (id) pending.add(id);
    }
    if (pending.size === 0) return false;

    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex += 1) {
      const result = messages[resultIndex];
      if (!result || typeof result !== "object") continue;
      const resultValue = result as { role?: unknown; toolCallId?: unknown };
      if (resultValue.role === "toolResult" && typeof resultValue.toolCallId === "string") {
        pending.delete(resultValue.toolCallId);
      }
    }

    // A later assistant message proves any older unmatched call was superseded,
    // not still executing. Only the newest assistant tool batch can be in flight.
    return pending.size > 0;
  }

  return false;
}

/**
 * Run Pi's native compaction pipeline at an awaited turn_end boundary without
 * aborting the active agent run. This is intentionally private to Blackhole:
 * callers must ensure all tools for the turn have completed.
 */
export async function compactInlineAtTurnBoundary(
  sessionManager: object,
  customInstructions?: string,
): Promise<CompactionResult> {
  const registry = getRegistry();
  const record = registry.sessions.get(sessionManager);
  if (!record) {
    throw new InlineCompactionUnavailableError(
      "Blackhole inline compaction is unavailable: owning AgentSession was not captured or Pi internals are unsupported" +
        ` (host candidates: ${registry.hostCandidateCount ?? 0}; captured sessions: ${registry.capturedSessionCount ?? 0})`,
    );
  }

  const { session, originalCompact, shape } = record;
  if (
    registry.compactionInFlight.has(session) ||
    session._compactionAbortController ||
    session._autoCompactionAbortController
  ) {
    throw new Error("Compaction already in progress");
  }

  const activeMessages = session.sessionManager.buildSessionContext().messages;
  if (hasTrailingUnpairedToolCall(activeMessages)) {
    throw new Error("Cannot compact inline while a tool call is still in flight");
  }

  registry.compactionInFlight.add(session);
  const restores: Array<() => void> = [];
  const realAbort = session.abort;
  let abortSuppressed = false;
  let disconnectSuppressed = false;
  const messagesBefore = session.agent.state.messages;

  let result!: CompactionResult;
  let operationFailed = false;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    try {
      if (shape.disconnectsAgent) {
        const realDisconnect = session._disconnectFromAgent;
        if (!realDisconnect) {
          throw new InlineCompactionUnavailableError(
            "Blackhole inline compaction is unavailable: disconnect hook disappeared",
          );
        }
        restores.push(
          shadowProperty(
            session,
            "_disconnectFromAgent",
            function inlineDisconnect(this: PatchableSession): void {
              if (!disconnectSuppressed) {
                disconnectSuppressed = true;
                return;
              }
              realDisconnect.call(this);
            },
          ),
        );
      }

      restores.push(
        shadowProperty(
          session,
          "abort",
          async function inlineAbort(this: PatchableSession): Promise<void> {
            if (!abortSuppressed) {
              abortSuppressed = true;
              return;
            }
            this._compactionAbortController?.abort();
            await realAbort.call(this);
          },
        ),
      );

      result = await originalCompact.call(session, customInstructions);
      // Mark the refresh before validating the quiesce invariant. If a future Pi
      // shape mutates state but does not invoke the expected hook, the error stays
      // explicit while the still-active loop is prevented from using stale context.
      registry.refreshPending.add(session);
      if (!abortSuppressed || (shape.disconnectsAgent && !disconnectSuppressed)) {
        throw new InlineCompactionUnavailableError(
          "Blackhole inline compaction invariant failed: Pi quiesce hooks were not invoked as expected",
        );
      }
    } catch (error) {
      if (session.agent.state.messages !== messagesBefore) {
        registry.refreshPending.add(session);
      }
      operationFailed = true;
      operationError = error;
    }
  } finally {
    registry.compactionInFlight.delete(session);
    for (let index = restores.length - 1; index >= 0; index -= 1) {
      try {
        restores[index]();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Blackhole inline compaction failed and could not restore all session properties",
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Blackhole inline compaction could not restore all session properties",
    );
  }
  return result;
}
