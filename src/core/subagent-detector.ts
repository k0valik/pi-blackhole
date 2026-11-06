/**
 * Subagent session detection.
 *
 * There is no pi-level "this is a subagent" flag: 50+ subagent extensions use
 * different spawn mechanisms (detached `pi` process, tmux/herdr pane,
 * in-process SDK session, forked conversation). This module is the single place
 * that decides whether the current session is a child, so adding support for a
 * new runner means adding one table entry — not editing gating code.
 *
 * Signals are evaluated strongest-first:
 *
 *  1. Explicit env markers set by known runners (`PI_SUBAGENT_*`, gentle-shell,
 *     user-supplied names via `PI_BLACKHOLE_SUBAGENT_MARKERS`).
 *  2. Runner-owned session evidence: custom entry types and session-file paths.
 *  3. The generic ancestry marker: every main session writes its id to
 *     `PI_BLACKHOLE_ROOT_SESSIONS`; children inherit that env var (in-process
 *     and detached) and have a different session id. This covers runners we
 *     have never heard of, as long as the child inherits the parent env.
 *  4. `fork` reason is ambiguous: a user `/fork` is a new main session, while a
 *     forked subagent runs on an in-memory session. Persisted fork => main,
 *     non-persisted fork => child.
 *  5. `resume` is ambiguous: `/resume` can load a main session or a session
 *     that was created as a child. Positive child evidence above still wins;
 *     otherwise a resumed session is main.
 *
 * Unknown sessions fail closed (treated as main), so a false negative costs
 * tokens but never silently disables memory for the user's own session.
 */

import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

export type SubagentMemoryMode = "off" | "inherit";
export type SubagentStartReason = SessionStartEvent["reason"];

/** Env var carrying the ancestry of every main session in this process. */
export const ROOT_SESSIONS_ENV = "PI_BLACKHOLE_ROOT_SESSIONS";
/** Comma-separated extra env names a user can add for an unsupported runner. */
export const EXTRA_MARKERS_ENV = "PI_BLACKHOLE_SUBAGENT_MARKERS";

export interface SubagentEnvMarker {
  /** Env var name. */
  name: string;
  /** Runner(s) known to set it, for debug output and docs. */
  runner: string;
  /** Optional value test. Default: non-empty and not a falsy token. */
  when?: (value: string) => boolean;
}

/**
 * Tier 1: explicit child identity env markers.
 *
 * Do NOT add parent-side configuration vars here (timeouts, budgets, debug
 * switches). They describe a runner's configuration, not the child identity,
 * and the parent usually has them set too.
 */
export const SUBAGENT_ENV_MARKERS: readonly SubagentEnvMarker[] = [
  { name: "PI_SUBAGENT_CHILD", runner: "pi-subagents (nicobailon), pi-herdsman" },
  { name: "PI_SUBAGENT_PARENT_SESSION", runner: "pi-subagents (nicobailon), pi-herdsman, edxeth" },
  { name: "PI_SUBAGENT_AGENT", runner: "edxeth" },
  { name: "PI_SUBAGENT_NAME", runner: "edxeth" },
  { name: "PI_SUBAGENT_SESSION", runner: "edxeth" },
  { name: "PI_SUBAGENT_SURFACE", runner: "edxeth" },
  { name: "PI_SUBAGENT_EXECUTION_BUDGET", runner: "pi-harness (HenryQW)" },
  { name: "PI_SUBAGENT_PROCESS_LEASE", runner: "pi-harness (HenryQW)" },
  { name: "PI_SUBAGENT_STEER_FILE", runner: "pi-better-subagents (1aboveio)" },
  {
    name: "PI_SUBAGENT_HERDR",
    runner: "@bacnh85/pi-subagent",
    // "off" is the child marker this runner uses to disable its herdr tool.
    when: (value) => !["", "0", "false"].includes(value.trim().toLowerCase()),
  },
  { name: "GENTLE_PI_AGENTS_CHILD", runner: "gentle-shell" },
  { name: "GENTLE_PI_AGENTS_OWNED_IPC", runner: "gentle-shell" },
  {
    name: "PI_SUBAGENT_DEPTH",
    runner: "@narumitw/pi-subagents",
    when: (value) => {
      const depth = Number.parseInt(value.trim(), 10);
      return Number.isInteger(depth) && depth > 0;
    },
  },
];

/** Tier 2: runner-owned session-file locations. */
export const SUBAGENT_SESSION_PATH_MARKERS: readonly { pattern: RegExp; runner: string }[] = [
  // <parentSessionFile>.subagents/<child>.jsonl
  { pattern: /(?:^|[\\/])[^\\/]+\.subagents[\\/][^\\/]+\.jsonl$/i, runner: "pi-submarine" },
  // Isolated worktree spawned by @bacnh85/pi-subagent.
  { pattern: /(?:^|[\\/])\.pi-worktrees[\\/][^\\/]+[\\/]/i, runner: "@bacnh85/pi-subagent" },
];

/** Tier 2: runner-owned custom entry types written into the child session. */
export const SUBAGENT_CUSTOM_ENTRY_TYPES: readonly { type: string; runner: string }[] = [
  { type: "pi-subagent:thread:v1", runner: "pi-subagent-manager" },
  { type: "pi-herdsman-agent-definition", runner: "pi-herdsman" },
];

/**
 * Session-start reasons that create a root unless positive child evidence was
 * found first. `fork` is only reached here when it was persisted or is a known
 * root (the in-memory subagent fork is handled earlier).
 */
const ROOT_SESSION_START_REASONS: Partial<Record<SubagentStartReason, string>> = {
  new: "session:new_root",
  resume: "session:resumed_root",
  fork: "session:manual_fork",
};

export interface SubagentProbe {
  env?: Readonly<Record<string, string | undefined>>;
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  isPersisted?: boolean;
  sessionStartReason?: SubagentStartReason;
  previousSessionFile?: string;
  entryCustomTypes?: readonly string[];
  /** Explicit root ids (tests); process state is also consulted. */
  rootSessionIds?: readonly string[];
}

export interface SubagentDecision {
  isSubagent: boolean;
  /** Stable machine-readable reason for debug logs and status output. */
  reason: string;
}

export interface SubagentContextLike {
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    isPersisted?: () => boolean;
    getSessionName?: () => string | undefined;
    getEntries?: () => readonly unknown[];
  };
}

/**
 * Main-session ids known to this process. Kept in module state as a fallback
 * for hosts that clear or overwrite the env var; the env var is what reaches
 * detached child processes.
 */
const moduleRootSessionIds = new Set<string>();

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isTruthyMarkerValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function readExtraMarkers(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return splitList(env[EXTRA_MARKERS_ENV]);
}

export function readRootSessionIds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return splitList(env[ROOT_SESSIONS_ENV]);
}

/**
 * Record a main session id so children spawned later inherit it, both in this
 * process (module state) and in detached children (env var).
 */
export function registerRootSession(
  sessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!sessionId) return;
  moduleRootSessionIds.add(sessionId);
  const ids = new Set(readRootSessionIds(env));
  ids.add(sessionId);
  env[ROOT_SESSIONS_ENV] = [...ids].join(",");
}

/** Drop a main session id (tests and explicit session teardown). */
export function unregisterRootSession(
  sessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!sessionId) return;
  moduleRootSessionIds.delete(sessionId);
  const ids = readRootSessionIds(env).filter((id) => id !== sessionId);
  if (ids.length > 0) env[ROOT_SESSIONS_ENV] = ids.join(",");
  else delete env[ROOT_SESSIONS_ENV];
}

/** Test-only: clear process-wide state. */
export function resetSubagentDetectorState(): void {
  moduleRootSessionIds.clear();
  delete process.env[ROOT_SESSIONS_ENV];
}

/**
 * Best-effort probe from a pi extension context. Every accessor is guarded:
 * a stale extension context throws on use, and detection must never be the
 * reason a session crashes.
 */
export function probeFromContext(
  ctx: SubagentContextLike | undefined,
  start?: { reason?: SubagentStartReason; previousSessionFile?: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): SubagentProbe {
  const safe = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // The property access itself throws on a stale ctx: pi invalidates a captured
  // context by making every session-bound accessor throw, and the footer polls
  // this probe from a timer. Keep the read inside the guard like the accessors.
  const manager = safe(() => ctx?.sessionManager);
  const entries = safe(() => manager?.getEntries?.() ?? []);
  const entryCustomTypes: string[] = [];
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    const customType = (entry as { customType?: unknown }).customType;
    if (typeof customType === "string") entryCustomTypes.push(customType);
  }
  return {
    env,
    sessionId: safe(() => manager?.getSessionId?.()),
    sessionName: safe(() => manager?.getSessionName?.()),
    sessionFile: safe(() => manager?.getSessionFile?.()),
    isPersisted: safe(() => manager?.isPersisted?.()),
    sessionStartReason: start?.reason,
    previousSessionFile: start?.previousSessionFile,
    entryCustomTypes,
  };
}

/** Pure decision function: no I/O, no config reads, safe to unit test. */
export function detectSubagentSession(probe: SubagentProbe): SubagentDecision {
  const env = probe.env ?? process.env;

  for (const name of readExtraMarkers(env)) {
    if (isTruthyMarkerValue(env[name] ?? "")) {
      return { isSubagent: true, reason: `env_custom:${name}` };
    }
  }

  for (const marker of SUBAGENT_ENV_MARKERS) {
    const value = env[marker.name];
    if (value === undefined) continue;
    if ((marker.when ?? isTruthyMarkerValue)(value)) {
      return { isSubagent: true, reason: `env:${marker.name}` };
    }
  }

  const customTypes = probe.entryCustomTypes;
  if (customTypes && customTypes.length > 0) {
    for (const marker of SUBAGENT_CUSTOM_ENTRY_TYPES) {
      if (customTypes.includes(marker.type)) {
        return { isSubagent: true, reason: `entry:${marker.type}` };
      }
    }
  }

  if (probe.sessionFile) {
    for (const marker of SUBAGENT_SESSION_PATH_MARKERS) {
      if (marker.pattern.test(probe.sessionFile)) {
        return { isSubagent: true, reason: `path:${marker.runner}` };
      }
    }
  }

  // A fork without ancestry evidence: manual /fork sessions are persisted,
  // while forked subagents (ESSO0428-style) run on in-memory sessions.
  if (
    probe.sessionStartReason === "fork" &&
    probe.isPersisted === false &&
    !isKnownRoot(probe.sessionId, probe.rootSessionIds, env)
  ) {
    return { isSubagent: true, reason: "session:fork_in_memory" };
  }

  const roots = collectRootSessionIds(probe.rootSessionIds, env);
  if (probe.sessionId && roots.size > 0 && !roots.has(probe.sessionId)) {
    const rootReason = probe.sessionStartReason
      ? ROOT_SESSION_START_REASONS[probe.sessionStartReason]
      : undefined;
    if (rootReason) return { isSubagent: false, reason: rootReason };
    return { isSubagent: true, reason: "session:root_ancestor_mismatch" };
  }

  return { isSubagent: false, reason: "session:main" };
}

function isKnownRoot(
  sessionId: string | undefined,
  explicit: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!sessionId) return false;
  return collectRootSessionIds(explicit, env).has(sessionId);
}

function collectRootSessionIds(
  explicit: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Set<string> {
  return new Set([...moduleRootSessionIds, ...readRootSessionIds(env), ...(explicit ?? [])]);
}

/** True when the knob asks to skip OM work for a detected subagent. */
export function isSubagentMemoryDisabled(
  mode: SubagentMemoryMode | undefined,
  decision: SubagentDecision,
): boolean {
  return (mode ?? "off") === "off" && decision.isSubagent;
}

/** Parse/canonicalize a file or env value; undefined means "not a valid value". */
export function normalizeSubagentMemoryMode(value: unknown): SubagentMemoryMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "inherit") return normalized;
  return undefined;
}
