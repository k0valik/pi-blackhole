import { createEventBus, type ExtensionAPI, type ExtensionEvent, type ExtensionHandler, type TurnEndEvent, type TurnEndEventResult, type SessionShutdownEvent, type AgentStartEvent, type SessionStartEvent } from "@earendil-works/pi-coding-agent";

/**
 * Host-interface double for extension wiring tests.
 *
 * `ExtensionAPI` declares a large required surface. This double implements the
 * whole interface as a real typed object — no cast — while `on` and
 * `appendEntry` carry the test state. Members no test exercises throw if
 * reached, so unexpected host usage fails loudly instead of silently passing.
 */
export interface ExtensionApiDoubleOptions {
  turnEndHandlers?: ExtensionHandler<TurnEndEvent, TurnEndEventResult>[];
  shutdownHandlers?: ExtensionHandler<SessionShutdownEvent>[];
  agentStartHandlers?: ExtensionHandler<AgentStartEvent>[];
  sessionStartHandlers?: ExtensionHandler<SessionStartEvent>[];
  appendEntry?: (customType: string, data: unknown) => unknown;
}

function notImplemented(member: keyof ExtensionAPI): () => never {
  return () => {
    throw new Error(`createExtensionApiDouble: ${String(member)} is not implemented`);
  };
}

export function createExtensionApiDouble(options: ExtensionApiDoubleOptions = {}): ExtensionAPI {
  return {
    on(...[event, handler]:
      | [event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>]
      | [event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>]
      | [event: "agent_start", handler: ExtensionHandler<AgentStartEvent>]
      | [event: "session_start", handler: ExtensionHandler<SessionStartEvent>]
      | [event: Exclude<ExtensionEvent["type"], "turn_end" | "session_shutdown" | "agent_start" | "session_start">, handler: (...args: never[]) => unknown]
    ): () => void {
      // Capture only events these fixtures replay.
      if (event === "turn_end") options.turnEndHandlers?.push(handler);
      if (event === "session_shutdown") options.shutdownHandlers?.push(handler);
      if (event === "agent_start") options.agentStartHandlers?.push(handler);
      if (event === "session_start") options.sessionStartHandlers?.push(handler);
      // Pi 0.87's `on()` returns an unsubscribe function; the double captures
      // handlers for replay and has nothing to detach.
      return () => {};
    },
    appendEntry(customType: string, data: unknown) {
      options.appendEntry?.(customType, data);
    },
    registerTool: notImplemented("registerTool"),
    registerCommand: notImplemented("registerCommand"),
    registerShortcut: notImplemented("registerShortcut"),
    registerFlag: notImplemented("registerFlag"),
    getFlag: notImplemented("getFlag"),
    registerMessageRenderer: notImplemented("registerMessageRenderer"),
    registerMarkdownTransformer: notImplemented("registerMarkdownTransformer"),
    registerEntryRenderer: notImplemented("registerEntryRenderer"),
    registerToolRenderer: notImplemented("registerToolRenderer"),
    sendMessage: notImplemented("sendMessage"),
    sendUserMessage: notImplemented("sendUserMessage"),
    setSessionName: notImplemented("setSessionName"),
    getSessionName: notImplemented("getSessionName"),
    setLabel: notImplemented("setLabel"),
    exec: notImplemented("exec"),
    getActiveTools: notImplemented("getActiveTools"),
    getAllTools: notImplemented("getAllTools"),
    getSettings: notImplemented("getSettings"),
    setActiveTools: notImplemented("setActiveTools"),
    getCommands: notImplemented("getCommands"),
    setModel: notImplemented("setModel"),
    getThinkingLevel: notImplemented("getThinkingLevel"),
    setThinkingLevel: notImplemented("setThinkingLevel"),
    registerProvider: notImplemented("registerProvider"),
    unregisterProvider: notImplemented("unregisterProvider"),
    registerMcpServer: notImplemented("registerMcpServer"),
    unregisterMcpServer: notImplemented("unregisterMcpServer"),
    getMcpServers: notImplemented("getMcpServers"),
    registerVirtualModel: notImplemented("registerVirtualModel"),
    unregisterVirtualModel: notImplemented("unregisterVirtualModel"),
    events: createEventBus(),
  };
}
