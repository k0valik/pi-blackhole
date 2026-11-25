import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Pi supplies host modules to extensions itself: `dist/core/extensions/loader.js`
 * aliases the `@earendil-works/pi-*` / `@mariozechner/pi-*` packages, `typebox`
 * and `@sinclair/typebox` (jiti aliases in Node builds, virtual modules in
 * bundled/binary builds), and reports a load warning when one of them is listed
 * in `dependencies` — an installed copy "can bypass the extension loader and
 * create duplicate runtime modules".
 *
 * Regression guard: 0.5.14 listed `typebox` in `dependencies` after a plain
 * Node.js `import` of the packed tarball failed with ERR_MODULE_NOT_FOUND. That
 * import path is not how pi loads the extension, so the physical copy was
 * unnecessary and shipped the warning this test keeps from returning.
 */
const HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

interface Manifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest: Manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

describe("package manifest — host-provided packages", () => {
  it("never declares a host-provided package as a runtime dependency", () => {
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ].filter((name) => HOST_PROVIDED_PACKAGES.includes(name));

    expect(declared).toEqual([]);
  });

  it("declares typebox as a host-provided peer with a * range", () => {
    expect(manifest.peerDependencies?.typebox).toBe("*");
  });

  it("keeps typebox available to the local build, typecheck and tests", () => {
    expect(manifest.devDependencies?.typebox).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * OMP refuses to load an extension bundle that contains any import specifier for
 * the legacy `pi-tui` package (its validator matches the scoped module path and
 * its subpaths), because that host module no longer exists there. The UI
 * primitives this package used to take from it now live in `src/ui/`, so nothing
 * may import them again.
 */
const FORBIDDEN_SPECIFIER_RE = /["'](?:@[\w.-]+\/)?pi-tui(?:\/[^"']*)?["']/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(url);
      else if (entry.name.endsWith(".ts")) out.push(fileURLToPath(url));
    }
  };
  walk(new URL("../src/", import.meta.url));
  out.push(fileURLToPath(new URL("../index.ts", import.meta.url)));
  return out;
}

describe("package manifest — pi-tui is not a host dependency", () => {
  it("declares no pi-tui dependency in any section", () => {
    const sections = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    const declared = sections.filter((section) =>
      Object.keys((manifest[section] ?? {}) as Record<string, string>).some((name) =>
        name.endsWith("/pi-tui"),
      ),
    );

    expect(declared).toEqual([]);
  });

  it("imports pi-tui from no source file", () => {
    const offenders = sourceFiles()
      .filter((file) => FORBIDDEN_SPECIFIER_RE.test(readFileSync(file, "utf-8")))
      .map((file) => file.split("/pi-blackhole/")[1] ?? file);

    expect(offenders).toEqual([]);
  });
});
