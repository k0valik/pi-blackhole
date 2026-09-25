/**
 * Scripted provider stream for tests that drive pi's real `agentLoop`.
 *
 * A scripted turn is returned per provider request. When the script runs out
 * the harness returns a terminal `stopReason: "error"` turn instead of
 * throwing: a throw inside `streamFn` rejects the agent loop's fire-and-forget
 * promise (`agentLoop` has no `.catch`) and leaves `stream.result()` pending,
 * so the run would hang until the vitest timeout instead of failing fast.
 */

import type {
  AssistantMessage,
  JsonObject,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

// pi-ai's declared Usage shape (types.d.ts) with every required field present,
// so a rename or a newly required key becomes a compile error here instead of
// silently reaching the loop that forwards usage to consumers.
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: (TextContent | ToolCall)[],
  stopReason: StopReason,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: ZERO_USAGE,
    timestamp: Date.now(),
    content,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/**
 * Build the scripted-stream helpers for one worker tool. `stream()` returns the
 * `streamFn` to hand to the worker plus a `calls()` counter that counts every
 * provider request — including requests past the end of the script, so an
 * unexpected extra turn is visible to the caller.
 */
export function createScriptedStream(toolName: string) {
  const toolCallTurn = (args: JsonObject) =>
    assistantMessage(
      [{ type: "toolCall", id: "call-1", name: toolName, arguments: args }],
      "toolUse",
    );

  const textTurn = (text = "run complete") =>
    assistantMessage([{ type: "text", text }], "stop");

  const stream = (script: ReadonlyArray<AssistantMessage>) => {
    let invocations = 0;
    const streamFn = async () => {
      const turnNumber = invocations++;
      const turn =
        script[turnNumber] ??
        assistantMessage(
          [],
          "error",
          `scripted stream exhausted: the agent loop requested turn ${turnNumber + 1}`,
        );
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done" };
        },
        async result() {
          return turn;
        },
      };
    };
    return { streamFn, calls: () => invocations };
  };

  return { toolCallTurn, textTurn, stream };
}
