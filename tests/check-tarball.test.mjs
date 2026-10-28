import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

function check(paths) {
  return spawnSync(process.execPath, ["scripts/check-tarball.mjs"], {
    input: JSON.stringify([{ files: paths.map((path) => ({ path, size: 1 })) }]),
    encoding: "utf8",
  });
}

test("accepts the required entry and lifecycle script", () => {
  assert.equal(check(["dist/index.js", "scripts/prepare.mjs"]).status, 0);
});

test("rejects a missing extension entry", () => {
  assert.match(check(["scripts/prepare.mjs"]).stderr, /dist\/index\.js/);
});

test("rejects a missing lifecycle script", () => {
  assert.match(check(["dist/index.js"]).stderr, /scripts\/prepare\.mjs/);
});

test("rejects sensitive files", () => {
  assert.match(
    check(["dist/index.js", "scripts/prepare.mjs", "config/.env"]).stderr,
    /config\/\.env/,
  );
});
