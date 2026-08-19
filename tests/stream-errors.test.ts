import { describe, expect, it, vi } from "vitest";
import { logAgentStreamError } from "../src/om/agents/stream-errors.js";

describe("logAgentStreamError", () => {
  it("reports message_end errors with the error message", () => {
    const onError = vi.fn();
    const message = logAgentStreamError(
      "observer",
      {
        type: "message_end",
        message: { stopReason: "error", errorMessage: "provider exploded" },
      },
      onError,
    );
    expect(message).toBe("provider exploded");
    expect(onError).toHaveBeenCalledWith("provider exploded");
  });

  it("reports aborted streams with a default message", () => {
    const message = logAgentStreamError("reflector", {
      type: "message_end",
      message: { stopReason: "aborted" },
    });
    expect(message).toContain("aborted");
  });

  it("reports agent_end failures from the last message", () => {
    const message = logAgentStreamError("dropper", {
      type: "agent_end",
      messages: [
        { stopReason: "toolUse" },
        { stopReason: "error", errorMessage: "rate limited" },
      ],
    });
    expect(message).toBe("rate limited");
  });

  it("returns undefined for clean terminations", () => {
    const onError = vi.fn();
    const message = logAgentStreamError(
      "observer",
      {
        type: "message_end",
        message: { stopReason: "stop" },
      },
      onError,
    );
    expect(message).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns undefined for unrelated events", () => {
    expect(
      logAgentStreamError("observer", { type: "tool_start" }),
    ).toBeUndefined();
  });
});
