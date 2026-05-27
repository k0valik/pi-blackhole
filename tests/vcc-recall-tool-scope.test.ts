import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall.js";

const makeSession = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-scope-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "active lineage token" } }),
    JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "off lineage secret" } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file };
};

const register = () => {
  let tool: any;
  registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
};

const invoke = async (tool: any, file: string, params: Record<string, unknown>) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => [{ id: "m1" }],
      getEntries: () => [{ id: "m1" }, { id: "m2" }],
    },
  });
  return result.content[0].text as string;
};

describe("vcc_recall scope", () => {
  it("defaults to active lineage and opts into all-session search explicitly", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const lineage = await invoke(tool, file, { query: "secret" });
      expect(lineage).toContain("No matches");

      const all = await invoke(tool, file, { query: "secret", scope: "all" });
      expect(all).toContain("scope: all");
      expect(all).toContain("off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps expand strict by default but allows off-lineage expand with scope all", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const lineage = await invoke(tool, file, { expand: [1] });
      expect(lineage).toContain("Cannot expand indices outside active lineage: 1");

      const all = await invoke(tool, file, { expand: [1], scope: "all" });
      expect(all).toContain("Scope: all");
      expect(all).toContain("#1 [user] off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
