import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall.js";

const makeSession = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-scope-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "active lineage token" },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: { role: "user", content: "off lineage secret" },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file };
};

const register = () => {
  let tool: any;
  registerRecallTool({
    registerTool: (t: any) => {
      tool = t;
    },
  } as any);
  return tool;
};

const invoke = async (
  tool: any,
  file: string,
  params: Record<string, unknown>,
  lineageEntryIds?: string[],
) => {
  return await tool
    .execute("tool-call", params, undefined, undefined, {
      sessionManager: {
        getSessionFile: () => file,
        getBranch: () => (lineageEntryIds ? lineageEntryIds.map((id) => ({ id })) : [{ id: "m1" }]),
        getEntries: () => [{ id: "m1" }, { id: "m2" }],
      },
    })
    .then((r: any) => r.content[0].text as string);
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

describe("drill-down scope", () => {
  it("blocks #N:path on off-lineage entries by default, allows with scope all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-drilldown-scope-"));
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        id: "m0",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc0",
              name: "edit",
              arguments: { path: "src/on.ts", oldText: "x", newText: "y" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc1",
              name: "edit",
              arguments: {
                path: "src/off.ts",
                oldText: "secret-old",
                newText: "secret-new",
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc2",
              name: "edit",
              arguments: { path: "src/on.ts", oldText: "a", newText: "b" },
            },
          ],
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    try {
      const tool = register();
      const lineage = ["m0", "m2"];

      // off-lineage entry blocked under default scope
      const blocked = await invoke(tool, file, { query: "#1:off.ts" }, lineage);
      expect(blocked).toContain("Cannot expand indices outside active lineage: 1");
      expect(blocked).not.toContain("secret-old");

      // on-lineage entry still drills under default scope
      const onOut = await invoke(tool, file, { query: "#0:on.ts" }, lineage);
      expect(onOut).toContain("src/on.ts");

      // scope:'all' reaches the other branch
      const allOut = await invoke(tool, file, {
        query: "#1:off.ts",
        scope: "all",
      });
      expect(allOut).toContain("src/off.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
