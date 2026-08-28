/**
 * TDD tests for session-scoped config store.
 *
 * Uses pi's own `parseSessionEntries` and `FileEntry` types so the
 * store is exercised against real session tree shape — no handrolled
 * callbacks or fake parentId maps.
 */

import { describe, expect, it, afterEach } from "vitest";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  getSessionConfig,
  setSessionConfig,
  clearSessionConfig,
  clearAllSessionConfigs,
} from "./config.ts";
import { getAncestorChain } from "./session.ts";

// ─────────────────────────────────────────────────────────────────────
// Fixtures — real JSONL content parsed by pi
// ─────────────────────────────────────────────────────────────────────

const SESSION_HEADER =
  '{"type":"session","version":3,"id":"sid-1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}\n';

// Linear chain: a1 -> a2 -> a3 -> a4
const LINEAR_ENTRIES = [
  '{"type":"message","id":"a1","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"x"}}\n',
  '{"type":"message","id":"a2","parentId":"a1","timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"assistant","content":"y"}}\n',
  '{"type":"message","id":"a3","parentId":"a2","timestamp":"2024-01-01T00:00:03.000Z","message":{"role":"user","content":"z"}}\n',
  '{"type":"message","id":"a4","parentId":"a3","timestamp":"2024-01-01T00:00:04.000Z","message":{"role":"assistant","content":"w"}}\n',
];

// Branch: a1 -> a2, plus b1 branches from a1, b2 from b1
const BRANCH_ENTRIES = [
  '{"type":"message","id":"a1","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"x"}}\n',
  '{"type":"message","id":"a2","parentId":"a1","timestamp":"2024-01-01T00:00:02.000Z","message":{"role":"assistant","content":"y"}}\n',
  '{"type":"message","id":"b1","parentId":"a1","timestamp":"2024-01-01T00:00:03.000Z","message":{"role":"user","content":"branch"}}\n',
  '{"type":"message","id":"b2","parentId":"b1","timestamp":"2024-01-01T00:00:04.000Z","message":{"role":"assistant","content":"branch2"}}\n',
];

function parse(content: string) {
  return parseSessionEntries(content);
}

// ─────────────────────────────────────────────────────────────────────
// Tests — getAncestorChain (session.ts)
// ─────────────────────────────────────────────────────────────────────

describe("getAncestorChain", () => {
  it("returns [leaf] when leaf has parentId null", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES[0]!);
    expect(getAncestorChain(entries, "a1")).toEqual(["a1"]);
  });

  it("walks leaf -> parent -> root", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    expect(getAncestorChain(entries, "a4")).toEqual(["a4", "a3", "a2", "a1"]);
  });

  it("returns chain for a branch leaf", () => {
    const entries = parse(SESSION_HEADER + BRANCH_ENTRIES.join(""));
    expect(getAncestorChain(entries, "b2")).toEqual(["b2", "b1", "a1"]);
  });

  it("returns empty array for unknown leafId", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    expect(getAncestorChain(entries, "nonexistent")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Tests — session config store
// ─────────────────────────────────────────────────────────────────────

describe("session config store", () => {
  afterEach(() => {
    clearAllSessionConfigs();
  });

  // ── round-trip ──────────────────────────────────────────────────────

  it("returns empty object when no session config exists", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    const result = getSessionConfig("test", "/cwd", "sid-1", "a1", entries);
    expect(result).toEqual({});
  });

  it("round-trips setSessionConfig -> getSessionConfig", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a2", { threshold: 10 });
    expect(getSessionConfig("test", "/cwd", "sid-1", "a2", entries)).toEqual({
      threshold: 10,
    });
  });

  // ── isolation ───────────────────────────────────────────────────────

  it("isolates different leafIds", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd", "sid-1", "a2", { threshold: 20 });
    expect(getSessionConfig("test", "/cwd", "sid-1", "a1", entries)).toEqual({
      threshold: 10,
    });
    expect(getSessionConfig("test", "/cwd", "sid-1", "a2", entries)).toEqual({
      threshold: 20,
    });
  });

  it("isolates different sessionIds", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd", "sid-2", "a1", { threshold: 20 });
    expect(getSessionConfig("test", "/cwd", "sid-1", "a1", entries)).toEqual({
      threshold: 10,
    });
    expect(getSessionConfig("test", "/cwd", "sid-2", "a1", entries)).toEqual({
      threshold: 20,
    });
  });

  it("isolates different cwds", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd1", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd2", "sid-1", "a1", { threshold: 20 });
    expect(getSessionConfig("test", "/cwd1", "sid-1", "a1", entries)).toEqual({
      threshold: 10,
    });
    expect(getSessionConfig("test", "/cwd2", "sid-1", "a1", entries)).toEqual({
      threshold: 20,
    });
  });

  // ── parent-chain inheritance ────────────────────────────────────────

  it("inherits from parent leaf when current leaf has no config", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    // a2's parent is a1; a2 has no own config
    expect(getSessionConfig("test", "/cwd", "sid-1", "a2", entries)).toEqual({
      threshold: 10,
    });
  });

  it("inherits from grandparent when parent has no config", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    // a3's parent is a2, a2's parent is a1; a2 has no config
    expect(getSessionConfig("test", "/cwd", "sid-1", "a3", entries)).toEqual({
      threshold: 10,
    });
  });

  it("prefers own config over parent config", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd", "sid-1", "a2", { threshold: 20 });
    // a3's parent is a2, a2 has config { threshold: 20 }
    expect(getSessionConfig("test", "/cwd", "sid-1", "a3", entries)).toEqual({
      threshold: 20,
    });
  });

  it("does not inherit across branches (different root)", () => {
    const entries = parse(SESSION_HEADER + BRANCH_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    // c1 has parentId null; c2's parent is c1. No config on c1 or c2.
    expect(getSessionConfig("test", "/cwd", "sid-1", "c1", entries)).toEqual({});
    expect(getSessionConfig("test", "/cwd", "sid-1", "c2", entries)).toEqual({});
  });

  it("inherits across branches when ancestor has config", () => {
    const entries = parse(SESSION_HEADER + BRANCH_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    // b1 branches from a1 (parentId = "a1")
    expect(getSessionConfig("test", "/cwd", "sid-1", "b1", entries)).toEqual({
      threshold: 10,
    });
    expect(getSessionConfig("test", "/cwd", "sid-1", "b2", entries)).toEqual({
      threshold: 10,
    });
  });

  // ── clearSessionConfig ──────────────────────────────────────────────

  it("clearSessionConfig removes the leaf's own config", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd", "sid-1", "a2", { threshold: 20 });
    clearSessionConfig("test", "/cwd", "sid-1", "a2");
    // a2 no longer has its own config; falls through to a1
    expect(getSessionConfig("test", "/cwd", "sid-1", "a2", entries)).toEqual({
      threshold: 10,
    });
    // a1 is untouched
    expect(getSessionConfig("test", "/cwd", "sid-1", "a1", entries)).toEqual({
      threshold: 10,
    });
  });

  it("clearSessionConfig on leaf with no config is a no-op", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    clearSessionConfig("test", "/cwd", "sid-1", "a3");
    expect(getSessionConfig("test", "/cwd", "sid-1", "a3", entries)).toEqual({
      threshold: 10,
    });
  });

  // ── clearAllSessionConfigs ──────────────────────────────────────────

  it("clearAllSessionConfigs wipes the entire store", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    setSessionConfig("test", "/cwd", "sid-1", "a1", { threshold: 10 });
    setSessionConfig("test", "/cwd", "sid-1", "a2", { threshold: 20 });
    setSessionConfig("test", "/cwd2", "sid-2", "a1", { threshold: 30 });
    clearAllSessionConfigs();
    expect(getSessionConfig("test", "/cwd", "sid-1", "a1", entries)).toEqual({});
    expect(getSessionConfig("test", "/cwd", "sid-1", "a2", entries)).toEqual({});
    expect(getSessionConfig("test", "/cwd2", "sid-2", "a1", entries)).toEqual({});
  });

  // ── NUL separator safety ────────────────────────────────────────────

  it("separates cwd, sessionId, leafId correctly even with special chars", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    const cwd = "/path/with spaces";
    const sessionId = "sid-with-dashes";
    const leafId = "a4"; // valid leaf in fixture
    setSessionConfig("test", cwd, sessionId, leafId, { threshold: 99 });
    expect(getSessionConfig("test", cwd, sessionId, leafId, entries)).toEqual({
      threshold: 99,
    });
  });

  it("does not conflate keys that share substrings", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    // Use valid leaf IDs from the fixture; the NUL separator prevents key collision
    setSessionConfig("test", "/cwd-a", "sid", "a1", { v: 1 });
    setSessionConfig("test", "/cwd", "sid-a", "a1", { v: 2 });
    setSessionConfig("test", "/cwd", "sid", "a1", { v: 3 });
    expect(getSessionConfig("test", "/cwd-a", "sid", "a1", entries)).toEqual({
      v: 1,
    });
    expect(getSessionConfig("test", "/cwd", "sid-a", "a1", entries)).toEqual({
      v: 2,
    });
    expect(getSessionConfig("test", "/cwd", "sid", "a1", entries)).toEqual({
      v: 3,
    });
  });

  // ── deep clone on set ───────────────────────────────────────────────

  it("does not leak mutations back into the stored config", () => {
    const entries = parse(SESSION_HEADER + LINEAR_ENTRIES.join(""));
    const config = { nested: { threshold: 10 } };
    setSessionConfig("test", "/cwd", "sid-1", "a1", config);
    config.nested.threshold = 999;
    expect(getSessionConfig("test", "/cwd", "sid-1", "a1", entries)).toEqual({
      nested: { threshold: 10 },
    });
  });
});
