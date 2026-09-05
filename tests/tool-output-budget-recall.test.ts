import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllMessages } from "../src/core/load-messages.js";
import { registerCompactionContextHook } from "../src/hooks/compaction-context.js";
import { registerRecallTool } from "../src/tools/recall.js";
import { buildRetainedToolOutputProjection } from "../src/core/tool-output-budget.js";

describe("tool-output budget recovery", () => {
  it("recovers an omitted output through its recall index without changing raw history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blackhole-tool-budget-"));
    const sessionFile = join(dir, "session.jsonl");
    const fullOutput = "full historical tool output that must remain recoverable";
    const entries = [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "inspect it" },
      },
      {
        id: "t1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: fullOutput }],
        },
      },
      {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: "I used the result" },
      },
    ];
    writeFileSync(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    try {
      let contextHandler: ((event: any, ctx: any) => any) | undefined;
      registerCompactionContextHook(
        {
          on: (_name: string, callback: (event: any, ctx: any) => any) => {
            contextHandler = callback;
          },
        } as any,
        {
          config: {
            debugLog: false,
            retainedToolOutputMaxTokens: 1,
          },
          ensureConfig: () => {},
        } as any,
      );
      const projection = buildRetainedToolOutputProjection(entries, entries, 1);
      const branch = [
        ...entries,
        {
          id: "c1",
          type: "compaction",
          summary: "complete fallback",
          firstKeptEntryId: "u1",
          details: {
            compactor: "blackhole",
            version: 1,
            sections: [],
            sourceMessageCount: 1,
            previousSummaryUsed: false,
            retainedToolOutputProjection: projection,
          },
        },
      ];
      const sessionManager = {
        getBranch: () => branch,
        getEntries: () => branch,
        getSessionFile: () => sessionFile,
      };
      const masked = contextHandler!(
        {
          messages: [
            { role: "compactionSummary", summary: "complete fallback" },
            ...entries.map((entry) => entry.message),
          ],
        },
        { sessionManager },
      ).messages;
      const marker = masked.find((message: any) => message.toolCallId === "call-1").content[0]
        .text as string;
      const recallQuery = marker.match(/recall (#\d+)/)?.[1];
      expect(recallQuery).toBe("#1");
      expect(marker).not.toContain(fullOutput);

      let recallTool: any;
      registerRecallTool({
        registerTool: (tool: any) => {
          recallTool = tool;
        },
      } as any);
      const recalled = await recallTool.execute(
        "recall-call",
        { query: recallQuery },
        undefined,
        undefined,
        { sessionManager },
      );

      expect(recalled.content[0].text).toContain(fullOutput);
      expect(loadAllMessages(sessionFile, true).rawMessages[1].content).toEqual([
        { type: "text", text: fullOutput },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
