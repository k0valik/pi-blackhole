import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Inline `docs/CHANGELOG.md` into `src/changelog/changelog.ts` at bundle
 * time so `dist/` is self-contained. Without this, `tsup clean:true`
 * would leave the bundle reading the file from the package root at
 * runtime — which fails when only `dist/` is shipped or when the file
 * is not copied. Mirrors `pi-session-name` / `pi-git-tools` prompt
 * inlining (see 42333c3b in pi-utils).
 */
function inlineChangelog() {
  return {
    name: "inline-changelog",
    setup(build: any) {
      build.onLoad({ filter: /.*[\\/]changelog\.ts$/ }, async (args: any) => {
        let source = readFileSync(args.path, "utf8");
        let content = "";
        // Prefer docs/CHANGELOG.md (canonical), fall back to root
        try {
          content = readFileSync(resolve(__dirname, "docs/CHANGELOG.md"), "utf8");
        } catch {
          try {
            content = readFileSync(resolve(__dirname, "CHANGELOG.md"), "utf8");
          } catch {
            content = "";
          }
        }
        source = source.replace(
          /const BUNDLED_CHANGELOG_TEXT: string \| undefined = undefined;/,
          `const BUNDLED_CHANGELOG_TEXT: string | undefined = ${JSON.stringify(content)};`,
        );
        return { contents: source, loader: "ts" };
      });
    },
  };
}

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "dist",
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: "es2022",
  esbuildPlugins: [inlineChangelog()],
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-tui",
    "typebox",
    "@sinclair/typebox",
  ],
});
