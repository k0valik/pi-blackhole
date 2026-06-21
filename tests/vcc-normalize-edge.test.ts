import { describe, it, expect } from "vitest";
import { normalize } from "../src/core/normalize.js";
import { filterNoise } from "../src/core/filter-noise.js";
import type { Message } from "@earendil-works/pi-ai";

const ts = Date.now();

describe("vcc-normalize and filter-noise edge cases", () => {
  describe("normalize", () => {
    it("handles image parts in user messages", () => {
      const msg: Message = {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mimeType: "image/png", data: "base64" } as any
        ],
        timestamp: ts
      };
      const blocks = normalize([msg]);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]).toEqual({ kind: "user", text: "[image: image/png]", sourceIndex: 0 });
    });

    it("handles multiple image parts", () => {
        const msg: Message = {
            role: "user",
            content: [
                { type: "image", mimeType: "image/png" } as any,
                { type: "image", mimeType: "image/jpeg" } as any
            ],
            timestamp: ts
        };
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].text).toBe("[image: image/png]");
        expect(blocks[1].text).toBe("[image: image/jpeg]");
    });

    it("handles user message with only image", () => {
        const msg: Message = { role: "user", content: [{ type: "image", mimeType: "a/b" } as any], timestamp: ts };
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toBe("[image: a/b]");
    });

    it("handles bashExecution role", () => {
      const msg = {
        role: "bashExecution",
        command: "ls -R",
        output: "file1.txt\nfile2.txt",
        exitCode: 0,
        timestamp: ts
      } as any;
      const blocks = normalize([msg]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        kind: "bash",
        command: "ls -R",
        output: "file1.txt\nfile2.txt",
        exitCode: 0,
        sourceIndex: 0
      });
    });

    it("handles thinking blocks in assistant messages", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal thought", redacted: false },
          { type: "text", text: "hello" }
        ],
        timestamp: ts
      } as any;
      const blocks = normalize([msg]);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ kind: "thinking", text: "internal thought", redacted: false, sourceIndex: 0 });
    });

    it("handles tool results", () => {
      const msg: Message = {
        role: "toolResult",
        toolName: "read",
        toolCallId: "tc1",
        content: "file content",
        isError: false,
        timestamp: ts
      };
      const blocks = normalize([msg]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        kind: "tool_result",
        name: "read",
        text: "file content",
        isError: false,
        sourceIndex: 0
      });
    });

    it("handles tool calls in assistant messages", () => {
        const msg: Message = {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "a.ts" } }],
            timestamp: ts
        } as any;
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            kind: "tool_call",
            name: "write",
            args: { path: "a.ts" },
            sourceIndex: 0
        });
    });

    it("returns empty for unknown roles", () => {
        const msg = { role: "system", content: "ignore me" } as any;
        expect(normalize([msg])).toHaveLength(0);
    });

    it("handles empty assistant content", () => {
        const msg: Message = { role: "assistant", content: [], timestamp: ts } as any;
        expect(normalize([msg])).toHaveLength(0);
    });

    it("handles string content in assistant message", () => {
        const msg: Message = { role: "assistant", content: "hello", timestamp: ts } as any;
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toBe("hello");
    });

    it("handles user message with multiple text parts", () => {
        const msg: Message = { role: "user", content: [{type: "text", text: "part 1"}, {type: "text", text: "part 2"}], timestamp: ts } as any;
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].text).toBe("part 1\npart 2");
    });

    it("handles assistant message with mixed text and tool calls", () => {
        const msg: Message = {
            role: "assistant",
            content: [
                { type: "text", text: "calling" },
                { type: "toolCall", id: "1", name: "t", arguments: {} }
            ],
            timestamp: ts
        } as any;
        const blocks = normalize([msg]);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].kind).toBe("assistant");
        expect(blocks[1].kind).toBe("tool_call");
    });
  });

  describe("filterNoise", () => {
    it("strips thinking blocks", () => {
      const blocks: any[] = [
        { kind: "thinking", text: "thought", sourceIndex: 0 },
        { kind: "assistant", text: "hello", sourceIndex: 0 }
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].kind).toBe("assistant");
    });

    it("strips noise tools (e.g. TodoWrite, ToolSearch)", () => {
      const blocks: any[] = [
        { kind: "tool_call", name: "TodoWrite", args: {}, sourceIndex: 0 },
        { kind: "tool_result", name: "TodoWrite", text: "ok", sourceIndex: 1 },
        { kind: "tool_call", name: "write", args: {}, sourceIndex: 2 }
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("write");
    });

    it("strips noise strings from user text", () => {
      const blocks: any[] = [
        { kind: "user", text: "Continue from where you left off.", sourceIndex: 0 },
        { kind: "user", text: "Real message", sourceIndex: 1 }
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].text).toBe("Real message");
    });

    it("cleans XML-like wrappers from user text", () => {
      const blocks: any[] = [
        { kind: "user", text: "<system-reminder>Remember this</system-reminder>Please do that", sourceIndex: 0 }
      ];
      const filtered = filterNoise(blocks);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].text).toBe("Please do that");
    });

    it("strips user message if it becomes empty after cleaning", () => {
        const blocks: any[] = [
            { kind: "user", text: "<system-reminder>only reminder</system-reminder>", sourceIndex: 0 }
        ];
        const filtered = filterNoise(blocks);
        expect(filtered).toHaveLength(0);
    });

    it("handles multiple XML wrappers in one message", () => {
        const text = "<ide_opened_file>a.ts</ide_opened_file> <command-message>done</command-message> task";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered[0].text).toBe("task");
    });

    it("preserves other block kinds (bash, tool_call, tool_result, assistant)", () => {
        const blocks: any[] = [
            { kind: "bash", command: "ls", sourceIndex: 0 },
            { kind: "assistant", text: "done", sourceIndex: 1 }
        ];
        const filtered = filterNoise(blocks);
        expect(filtered).toHaveLength(2);
    });

    it("handles mixed noise and valid content in user message", () => {
        const text = "IMPORTANT: TodoWrite was not called yet. But I want you to fix it.";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered).toHaveLength(0);
    });

    it("handles WebSearch tool as noise", () => {
        const blocks: any[] = [{ kind: "tool_call", name: "WebSearch", args: {}, sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(0);
    });

    it("handles AskUser tool as noise", () => {
        const blocks: any[] = [{ kind: "tool_call", name: "AskUser", args: {}, sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(0);
    });

    it("handles XML wrappers with attributes", () => {
        const text = '<system-reminder priority="high">Wait</system-reminder>Go';
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered[0].text).toBe("Go");
    });

    it("handles nested-looking but actually sequential XML wrappers", () => {
        const text = "<system-reminder>A</system-reminder><system-reminder>B</system-reminder>C";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered[0].text).toBe("C");
    });

    it("handles context-window-usage wrapper", () => {
        const text = "<context-window-usage>tokens: 100</context-window-usage>Work";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered[0].text).toBe("Work");
    });

    it("handles noise string with unusual casing", () => {
        // NOISE_STRINGS matches exactly.
        const text = "CONTINUE FROM WHERE YOU LEFT OFF.";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        const filtered = filterNoise(blocks);
        expect(filtered).toHaveLength(1); // Case sensitive!
    });

    it("handles GenerateDroid tool as noise", () => {
        const blocks: any[] = [{ kind: "tool_call", name: "GenerateDroid", args: {}, sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(0);
    });

    it("handles ExitSpecMode tool as noise", () => {
        const blocks: any[] = [{ kind: "tool_call", name: "ExitSpecMode", args: {}, sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(0);
    });

    it("strips user message containing only whitespace after cleaning", () => {
        const text = "<system-reminder>x</system-reminder>   ";
        const blocks: any[] = [{ kind: "user", text, sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(0);
    });

    it("preserves tool_result if it is not a noise tool", () => {
        const blocks: any[] = [{ kind: "tool_result", name: "read", text: "data", sourceIndex: 0 }];
        expect(filterNoise(blocks)).toHaveLength(1);
    });

    it("handles empty blocks array", () => {
        expect(filterNoise([])).toHaveLength(0);
    });

    it("does not crash on blocks with missing text field (if they exist)", () => {
        const blocks: any[] = [{ kind: "assistant", sourceIndex: 0 }];
        // sanitize(undefined) -> ""
        // This test ensures it doesn't throw.
        expect(filterNoise(blocks)).toHaveLength(1);
    });
  });
});
