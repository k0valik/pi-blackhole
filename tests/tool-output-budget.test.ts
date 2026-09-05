import { describe, expect, it } from "vitest";
import {
  applyRetainedToolOutputProjection,
  applyToolOutputBudget,
  buildRetainedToolOutputProjection,
} from "../src/core/tool-output-budget.js";

describe("applyToolOutputBudget", () => {
  it("freezes omissions while preserving pending results and non-text content", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const entries = [
      {
        id: "old",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "old-call",
          content: [{ type: "text", text: "o".repeat(12) }, image],
        },
      },
      {
        id: "used",
        type: "message",
        message: { role: "assistant", content: "used old" },
      },
      {
        id: "new",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "new-call",
          content: "n".repeat(8),
        },
      },
      {
        id: "used-new",
        type: "message",
        message: { role: "assistant", content: "used new" },
      },
      {
        id: "pending",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "pending-call",
          content: "p".repeat(40),
        },
      },
    ];

    const projection = buildRetainedToolOutputProjection(entries, entries, 2);
    const messages = entries.map((entry) => structuredClone(entry.message));
    const projected = applyRetainedToolOutputProjection(messages, entries, projection);

    expect(projected[0].content[0].text).toContain("recall #0");
    expect(projected[0].content[1]).toEqual(image);
    expect(projected[2]).toEqual(messages[2]);
    expect(projected[4]).toEqual(messages[4]);
    expect(projection.pendingCount).toBe(1);
  });

  it("does not persist an omission when a transcript entry id is not unique", () => {
    const output = {
      id: "duplicate",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        content: "x".repeat(20),
      },
    };
    const retained = [
      output,
      {
        id: "assistant",
        type: "message",
        message: { role: "assistant", content: "consumed" },
      },
    ];
    const allEntries = [
      output,
      {
        id: "duplicate",
        type: "message",
        message: { role: "user", content: "corrupt duplicate" },
      },
      retained[1],
    ];

    const projection = buildRetainedToolOutputProjection(retained, allEntries, 1);
    const messages = retained.map((entry) => entry.message);
    const projected = applyRetainedToolOutputProjection(messages, allEntries, projection);

    expect(projection.omissions).toEqual([]);
    expect(projection.omittedTokens).toBe(0);
    expect(projection.retainedTokens).toBe(5);
    expect(projected).toBe(messages);
    expect(projected[0]).toBe(output.message);
  });

  it("uses a generic marker when a unique id has no transcript index", () => {
    const retained = [
      {
        id: "unique",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: "x".repeat(20),
        },
      },
      {
        id: "assistant",
        type: "message",
        message: { role: "assistant", content: "consumed" },
      },
    ];

    const projection = buildRetainedToolOutputProjection(retained, [], 1);

    expect(projection.omissions[0]?.marker).toBe(
      "[Tool output text omitted from active context; use recall.]",
    );
  });

  it("prefers object identity over an equal later message during replay", () => {
    const persisted = {
      role: "toolResult",
      toolCallId: "reused-call",
      content: "same output",
    };
    const marker = "[Tool output text omitted from active context; recall #1.]";
    const messages = [persisted, structuredClone(persisted)];

    const projected = applyRetainedToolOutputProjection(
      messages,
      [{ id: "old", type: "message", message: persisted }],
      {
        version: 1,
        retainedTokens: 0,
        omittedTokens: 3,
        pendingCount: 0,
        omissions: [{ entryId: "old", marker }],
      },
    );

    expect(projected[0].content).toBe(marker);
    expect(projected[1]).toEqual(persisted);
  });

  it("keeps an output that exactly fits the budget without cloning history", () => {
    const messages = [
      { role: "toolResult", toolName: "read", content: "12345678" },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 2);

    expect(result.messages).toBe(messages);
    expect(result.retainedTokens).toBe(2);
    expect(result.omittedCount).toBe(0);
  });

  it("masks shell output while retaining execution metadata", () => {
    const messages = [
      {
        role: "bashExecution",
        command: "build",
        output: "x".repeat(8),
        exitCode: 1,
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages[0]).toMatchObject({
      role: "bashExecution",
      command: "build",
      exitCode: 1,
    });
    expect(result.messages[0].output).toContain("omitted from active context");
    expect(messages[0].output).toBe("xxxxxxxx");
  });

  it("replaces text while preserving non-text tool-result content", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "capture",
        content: [{ type: "text", text: "x".repeat(8) }, image],
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1, new Map([[0, 4]]));

    expect(result.messages[0].content[0].text).toContain("recall #4");
    expect(result.messages[0].content[1]).toBe(image);
    expect(messages[0].content[0].text).toBe("xxxxxxxx");
  });

  it("protects outputs when no successful assistant has consumed them", () => {
    const messages = [{ role: "bashExecution", command: "build", output: "x".repeat(20) }];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages).toBe(messages);
    expect(result.pendingCount).toBe(1);
  });

  it("does not treat errored or aborted assistants as consumption boundaries", () => {
    for (const stopReason of ["error", "aborted"]) {
      const messages = [
        { role: "toolResult", toolName: "read", content: "x".repeat(20) },
        { role: "assistant", stopReason, content: [] },
      ];

      const result = applyToolOutputBudget(messages, 1);

      expect(result.messages).toBe(messages);
      expect(result.pendingCount).toBe(1);
    }
  });

  it("treats non-string/non-array tool-result content as textless", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "custom",
        content: { data: "opaque" },
      },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages).toBe(messages);
    expect(result.retainedTokens).toBe(0);
    expect(result.omittedCount).toBe(0);
  });

  it("leaves image-only results unchanged after the text budget is exhausted", () => {
    const image = { type: "image", data: "encoded", mimeType: "image/png" };
    const messages = [
      { role: "toolResult", toolName: "capture", content: [image] },
      { role: "toolResult", toolName: "old", content: "x".repeat(8) },
      { role: "assistant", content: "consumed" },
    ];

    const result = applyToolOutputBudget(messages, 1);

    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1].content).toContain("text omitted");
  });
});
