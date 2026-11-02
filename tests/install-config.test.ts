import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/install.yml", import.meta.url), "utf8");

describe("production install peer configuration", () => {
  it("sets the same peer-install policy for ordinary and production installs", () => {
    expect(workspace).toMatch(/^autoInstallPeers: false$/m);
  });

  it("records that policy in the frozen lockfile", () => {
    expect(lockfile).toMatch(/^  autoInstallPeers: false$/m);
  });

  it("uses the same policy in the production install workflow", () => {
    expect(workflow).toMatch(/pnpm install --prod\s+--config\.auto-install-peers=false\b/);
  });
});
