/**
 * Regression test: the session_start migration-notice path must not crash pi.
 *
 * index.ts defers the 0.5.2 migration notice behind a dynamic `import()`, so it
 * runs on a later tick — after `session_start` returns. If the session is
 * disposed in that window (quit, /reload, /new right after startup), pi's ctx
 * accessors (`ctx.cwd`, `ctx.ui`) throw:
 *
 *   "This extension ctx is stale after session replacement or reload."
 *
 * The `.then()` body was not catch-terminated, so that throw became an
 * *unhandled rejection*, which terminates the node process. The fix guards the
 * access and adds a `.catch()`.
 *
 * These tests pin the handler's shape statically (the host lifecycle is not
 * reachable from a unit test) plus the disposal contract the guard relies on.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(resolve(ROOT, "index.ts"), "utf8");
}

/** The session_start handler that schedules the migration notice. */
function sessionStartHandler(): string {
  const src = source();
  const start = src.indexOf('pi.on("session_start"');
  expect(start, "index.ts must register a session_start handler").toBeGreaterThan(-1);
  // Handler body ends at the next `});` at the same nesting depth.
  const end = src.indexOf("\n  });", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("session_start migration notice resilience", () => {
  test("the deferred migration-notice import is catch-terminated", () => {
    const handler = sessionStartHandler();
    expect(handler).toContain("import(");
    expect(handler).toMatch(/\.then\(/);
    expect(
      handler,
      "a dynamic-import .then() that touches ctx MUST have a .catch() — " +
        "an unguarded throw there is an unhandled rejection and kills pi",
    ).toMatch(/\.catch\(/);
  });

  test("ctx access inside the deferred body is disposal-guarded or try/caught", () => {
    const handler = sessionStartHandler();
    // Either an explicit liveness check, or the access wrapped in try/catch.
    const guarded =
      /ctx\?\./.test(handler) || /\bif\s*\(\s*disposed\b/.test(handler) || /try\s*\{/.test(handler);
    const catchTerminated = /\.catch\(/.test(handler);
    expect(
      guarded || catchTerminated,
      "reading ctx.cwd/ctx.ui off a possibly-disposed ctx must be guarded " +
        "or the whole chain catch-terminated",
    ).toBe(true);
  });

  test("no bare `void import(...).then(...)` without a catch anywhere in index.ts", () => {
    const src = source();
    // Find every `void import(` ... capture to the end of its statement chain.
    const re = /void\s+import\([^)]*\)/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(src)) !== null) {
      // Look ahead for the terminating `;` or `);` of the chain.
      const rest = src.slice(m.index, m.index + 800);
      const chainEnd = rest.indexOf("\n  });");
      const chain = chainEnd === -1 ? rest : rest.slice(0, chainEnd);
      if (!/\.then\(/.test(chain)) continue;
      checked++;
      expect(chain, `unhandled dynamic import at index ${m.index}: add .catch()`).toMatch(
        /\.catch\(/,
      );
    }
    expect(checked, "expected at least one deferred import to inspect").toBeGreaterThan(0);
  });
});
