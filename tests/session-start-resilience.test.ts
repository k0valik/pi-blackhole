/**
 * Regression test: the session_start config-migration + notice path must not
 * crash pi.
 *
 * index.ts runs `migrateConfigFiles()` and, when a migration ran, defers the
 * release notice behind a dynamic `import()`. Both touch `ctx` after
 * `session_start` returns; if the session is disposed in that window (quit,
 * /reload, /new right after startup), pi's ctx accessors (`ctx.cwd`, `ctx.ui`)
 * throw:
 *
 *   "This extension ctx is stale after session replacement or reload."
 *
 * An unguarded throw on a deferred tick becomes an *unhandled rejection*, which
 * terminates the node process. The handler therefore wraps the deferred work in
 * an async IIFE with a try/catch.
 *
 * These tests pin the handler's shape statically (the host lifecycle is not
 * reachable from a unit test).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(resolve(ROOT, "index.ts"), "utf8");
}

/** The session_start handler that runs the config migration + notice. */
function sessionStartHandler(): string {
  const src = source();
  const start = src.indexOf('pi.on("session_start"');
  expect(start, "index.ts must register a session_start handler").toBeGreaterThan(-1);
  // Handler body ends at the next `});` at the same nesting depth.
  const end = src.indexOf("\n  });", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("session_start migration + notice resilience", () => {
  test("the deferred migration-notice import is guarded by try/catch", () => {
    const handler = sessionStartHandler();
    expect(handler).toContain("import(");
    expect(
      handler,
      "the deferred body MUST be try/caught — an unguarded throw there is an " +
        "unhandled rejection and kills pi",
    ).toMatch(/try\s*\{/);
    expect(handler).toMatch(/\}\s*catch\s*\{/);
  });

  test("ctx access inside the deferred body is disposal-guarded or try/caught", () => {
    const handler = sessionStartHandler();
    // Either an explicit liveness check, an async IIFE with try/catch, or a
    // `.catch()` on the chain.
    const guarded =
      /ctx\?\./.test(handler) ||
      /\bif\s*\(\s*disposed\b/.test(handler) ||
      /try\s*\{/.test(handler) ||
      /\.catch\(/.test(handler);
    expect(guarded).toBe(true);
  });

  test("no bare `void import(...).then(...)` without a catch anywhere in index.ts", () => {
    const src = source();
    // Find every `void import(` ... capture to the end of its statement chain.
    const re = /void\s+import\([^)]*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Look ahead for the terminating `;` or `);` of the chain.
      const rest = src.slice(m.index, m.index + 800);
      const chainEnd = rest.indexOf("\n  });");
      const chain = chainEnd === -1 ? rest : rest.slice(0, chainEnd);
      if (!/\.then\(/.test(chain)) continue;
      expect(chain, `unhandled dynamic import at index ${m.index}: add .catch()`).toMatch(
        /\.catch\(/,
      );
    }
  });
});
