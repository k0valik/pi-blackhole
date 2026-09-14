/**
 * Entrypoint wiring test: the extension factory must await the host adapter
 * probe and hand its result to the runtime that triggers receive.
 *
 * Every sibling module of `index.ts` is mocked so this stays a wiring test —
 * no Pi host, no config file, no network.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

const installMock = vi.fn();
const registerCompactionTriggerMock = vi.fn();
const registerPreCompactionOutputMock = vi.fn();

vi.mock("../src/core/settings", () => ({ scaffoldSettings: vi.fn() }));
vi.mock("../src/hooks/before-compact", () => ({ registerBeforeCompactHook: vi.fn() }));
vi.mock("../src/hooks/compact-failed", () => ({ registerCompactFailedHook: vi.fn() }));
vi.mock("../src/hooks/compaction-context", () => ({ registerCompactionContextHook: vi.fn() }));
vi.mock("../src/hooks/cosmetic-output", () => ({
  registerPreCompactionOutput: registerPreCompactionOutputMock,
}));
vi.mock("../src/commands/pi-vcc", () => ({ registerPiVccCommand: vi.fn() }));
vi.mock("../src/commands/memory", () => ({ registerMemoryCommand: vi.fn() }));
vi.mock("../src/commands/vcc-recall", () => ({ registerVccRecallCommand: vi.fn() }));
vi.mock("../src/commands/blackhole-export", () => ({ registerBlackholeExportCommand: vi.fn() }));
vi.mock("../src/om/consolidation", () => ({ registerConsolidationTrigger: vi.fn() }));
vi.mock("../src/tools/recall", () => ({ registerRecallTool: vi.fn() }));
vi.mock("../src/om/provider-stream", () => ({ captureRegisteredProviderStreams: vi.fn() }));
vi.mock("../src/om/inline-compaction", () => ({
  installHostInlineCompactionAdapter: installMock,
}));
vi.mock("../src/om/compaction-trigger", () => ({
  registerCompactionTrigger: registerCompactionTriggerMock,
}));
vi.mock("../src/om/runtime", () => ({
  Runtime: class Runtime {
    inlineCompactionAdapterStatus?: { supported: boolean; reason?: string };
  },
}));

function createPiMock(): ExtensionAPI {
  return createExtensionApiDouble();
}

describe("extension factory wiring", () => {
  beforeEach(() => {
    installMock.mockReset();
    registerCompactionTriggerMock.mockReset();
    registerPreCompactionOutputMock.mockReset();
  });

  it("awaits the host adapter probe and stores its status on the trigger runtime", async () => {
    let resolveInstall: (status: unknown) => void = () => {};
    installMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    let registeredStatus: unknown = "trigger-not-registered";
    registerCompactionTriggerMock.mockImplementation(
      (_pi: unknown, runtime: { inlineCompactionAdapterStatus?: unknown }) => {
        registeredStatus = runtime.inlineCompactionAdapterStatus;
      },
    );
    const { default: factory } = await import("../index");
    let settled = false;
    const run = factory(createPiMock()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(registerCompactionTriggerMock).not.toHaveBeenCalled();

    const failureStatus = {
      supported: false,
      reason:
        "host AgentSession module could not be resolved (dist/main.js: AgentSession export missing)",
    };
    resolveInstall(failureStatus);
    await run;

    expect(registeredStatus).toEqual(failureStatus);
    expect(registerPreCompactionOutputMock).toHaveBeenCalledOnce();
  });
});
