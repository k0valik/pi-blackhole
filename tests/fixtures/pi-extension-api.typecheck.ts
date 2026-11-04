import type {
  AgentStartEvent,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createExtensionApiDouble, type ExtensionApiDoubleOptions } from "./pi-extension-api.js";

// Compile-only contract. Never execute the intentionally invalid calls below.
export function checkHandlerReplay(event: TurnEndEvent, ctx: ExtensionContext): void {
  const handlers: NonNullable<ExtensionApiDoubleOptions["turnEndHandlers"]> = [];
  const pi = createExtensionApiDouble({ turnEndHandlers: handlers });
  pi.on("turn_end", (received, context) => {
    received.type satisfies "turn_end";
    context satisfies ExtensionContext;
  });
  const handler = handlers[0];
  if (!handler) throw new Error("turn_end handler missing");
  handler(event, ctx);
  // @ts-expect-error Replay must reject null events.
  handler(null, ctx);
  // @ts-expect-error Replay must reject a different event type.
  handler({ type: "agent_start" }, ctx);
  // @ts-expect-error Replay requires a complete host context.
  handler(event, { signal: undefined });
}

export function checkAgentStartReplay(event: AgentStartEvent, ctx: ExtensionContext): void {
  const handlers: NonNullable<ExtensionApiDoubleOptions["agentStartHandlers"]> = [];
  const pi = createExtensionApiDouble({ agentStartHandlers: handlers });
  pi.on("agent_start", (received, context) => {
    received.type satisfies "agent_start";
    context satisfies ExtensionContext;
  });
  const handler = handlers[0];
  if (!handler) throw new Error("agent_start handler missing");
  handler(event, ctx);
  // @ts-expect-error Replay must reject a different event type.
  handler({ type: "turn_end" }, ctx);
}

export function checkSessionStartReplay(event: SessionStartEvent, ctx: ExtensionContext): void {
  const handlers: NonNullable<ExtensionApiDoubleOptions["sessionStartHandlers"]> = [];
  const pi = createExtensionApiDouble({ sessionStartHandlers: handlers });
  pi.on("session_start", (received, context) => {
    received.type satisfies "session_start";
    received.reason satisfies "startup" | "reload" | "new" | "resume" | "fork";
    context satisfies ExtensionContext;
  });
  const handler = handlers[0];
  if (!handler) throw new Error("session_start handler missing");
  handler(event, ctx);
  // @ts-expect-error Replay must reject an invalid reason.
  handler({ type: "session_start", reason: "bogus" }, ctx);
}
