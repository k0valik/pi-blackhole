/**
 * Number field inline editing — regression tests.
 *
 * Step-based number fields (step !== undefined) must support direct
 * typing: Enter starts editing, typed chars + backspace update the
 * buffer, Enter commits, Esc cancels. ←/→ fine-tune by step when not
 * editing. This guards against the "editing dead end" where Enter
 * showed a cursor but backspace/typing/escape were swallowed.
 */
import { describe, it, expect } from "vitest";
import { numberRenderer } from "../src/pi-base/settings/fields/string.js";

function makeEnv(initial = 180000) {
  const editStates = new Map();
  const env: {
    isEditing: boolean;
    ctx: { editStates: Map<string, unknown> };
    setEditing: (v: boolean) => void;
  } = {
    isEditing: false,
    ctx: { editStates },
    setEditing: (v: boolean) => {
      env.isEditing = v;
    },
  };
  const row = {
    field: {
      key: "compactAfterTokens",
      type: "number",
      label: "T",
      value: initial,
      step: 1000,
      min: 1000,
      max: 500000,
    },
    value: initial,
  };
  return { env, row };
}

describe("number field inline editing", () => {
  it("Enter starts editing, typed chars reach the buffer", () => {
    const { env, row } = makeEnv(1000);
    const r1 = numberRenderer.handleKey(row as any, "\r", env as any);
    expect(r1.consumed).toBe(true);
    expect(env.isEditing).toBe(true);

    // Type '5' — must land in the buffer (this failed when the step
    // branch swallowed non-arrow keys while editing).
    numberRenderer.handleKey(row as any, "5", env as any);

    const r2 = numberRenderer.handleKey(row as any, "\r", env as any);
    expect(r2.commit).toBe(10005);
  });

  it("backspace removes a typed char", () => {
    const { env, row } = makeEnv(1000);
    numberRenderer.handleKey(row as any, "\r", env as any);
    numberRenderer.handleKey(row as any, "5", env as any); // 10005
    numberRenderer.handleKey(row as any, "\x7f", env as any); // 1000
    const r = numberRenderer.handleKey(row as any, "\r", env as any);
    expect(r.commit).toBe(1000);
  });

  it("escape cancels editing without committing", () => {
    const { env, row } = makeEnv();
    numberRenderer.handleKey(row as any, "\r", env as any);
    numberRenderer.handleKey(row as any, "5", env as any);
    const r = numberRenderer.handleKey(row as any, "\x1b", env as any);
    expect(r.consumed).toBe(true);
    expect(r.commit).toBeUndefined();
    expect(env.isEditing).toBe(false);
  });

  it("←/→ fine-tune by step when not editing", () => {
    const { env, row } = makeEnv(180000);
    const left = numberRenderer.handleKey(row as any, "\x1b[D", env as any);
    expect(left.commit).toBe(179000);
    const right = numberRenderer.handleKey(row as any, "\x1b[C", env as any);
    expect(right.commit).toBe(181000);
  });

  it("←/→ move the cursor while editing (no commit)", () => {
    const { env, row } = makeEnv();
    numberRenderer.handleKey(row as any, "\r", env as any);
    const r = numberRenderer.handleKey(row as any, "\x1b[D", env as any);
    expect(r.commit).toBeUndefined();
  });

  it("invalid input (below min) is rejected on commit", () => {
    const { env, row } = makeEnv();
    numberRenderer.handleKey(row as any, "\r", env as any);
    // Clear the buffer then type a value below min.
    numberRenderer.handleKey(row as any, "\x15", env as any); // ctrl+u
    numberRenderer.handleKey(row as any, "9", env as any);
    expect(() => numberRenderer.handleKey(row as any, "\r", env as any)).toThrow(/≥ 1000/);
  });

  it("Kitty CSI-u printable sequences type into the buffer (integration)", () => {
    const { env, row } = makeEnv(1000);
    numberRenderer.handleKey(row as any, "\r", env as any);
    // In a Kitty terminal, "5" arrives as \x1b[53u — it must flow
    // through handleInlineEditInput → isPlainSearchInput and insert.
    numberRenderer.handleKey(row as any, "\x1b[53u", env as any);
    const r = numberRenderer.handleKey(row as any, "\r", env as any);
    expect(r.commit).toBe(10005);
  });
});
