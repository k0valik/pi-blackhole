import { describe, test, expect } from "vitest";
import { createStatusOverlay } from "../src/om/status-overlay.js";

const mockTheme = {
  fg: (_style: string, text: string) => text,
};

function makeTui() {
  return { requestRender: () => {} };
}

const defaultInfo = {
  compaction: "auto" as const,
  compactionEngine: "blackhole" as const,
  tailBehavior: "pi-default" as const,
  memory: true,
  compactAfterTokens: 81000,
  consolidationInFlight: false,
  compactInFlight: false,
};

describe("createStatusOverlay", () => {
  test("returns render, handleInput, invalidate, dispose", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    expect(overlay).toHaveProperty("render");
    expect(overlay).toHaveProperty("handleInput");
    expect(overlay).toHaveProperty("invalidate");
    expect(overlay).toHaveProperty("dispose");
  });

  test("render returns lines with header", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Blackhole Status"))).toBe(true);
  });

  test("render shows compaction config values", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const joined = overlay.render(80).join("\n");
    expect(joined).toContain("auto");
    expect(joined).toContain("blackhole");
    expect(joined).toContain("pi-default");
  });

  test("render shows pipeline state", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const joined = overlay.render(80).join("\n");
    expect(joined).toContain("Compaction in flight");
    expect(joined).toContain("Consolidation in flight");
  });

  test("render shows error info when present", () => {
    const info = {
      ...defaultInfo,
      lastObserverError: "API timeout",
      lastReflectorError: "Rate limited",
    };
    const overlay = createStatusOverlay(info, mockTheme, makeTui(), () => {});
    const joined = overlay.render(80).join("\n");
    expect(joined).toContain("API timeout");
    expect(joined).toContain("Rate limited");
  });

  test("render shows actions section", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const joined = overlay.render(80).join("\n");
    expect(joined).toContain("Open configure overlay");
    expect(joined).toContain("Close");
  });

  test("down arrow navigates", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const linesBefore = overlay.render(80);
    overlay.handleInput("\x1b[B"); // down
    const linesAfter = overlay.render(80);
    expect(linesAfter.join("\n")).not.toBe(linesBefore.join("\n"));
  });

  test("up arrow navigates", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    overlay.handleInput("\x1b[B"); // down
    overlay.handleInput("\x1b[B"); // down
    const linesDown = overlay.render(80);
    overlay.handleInput("\x1b[A"); // up
    const linesUp = overlay.render(80);
    expect(linesUp.join("\n")).not.toBe(linesDown.join("\n"));
  });

  test("escape closes with action close", () => new Promise<void>((done) => {
    createStatusOverlay(defaultInfo, mockTheme, makeTui(), (result) => {
      expect(result).toEqual({ action: "close" });
      done();
    }).handleInput("\x1b");
  }));

  test("enter on configure action returns configure", () => new Promise<void>((done) => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), (result) => {
      expect(result).toEqual({ action: "configure" });
      done();
    });
    // Navigate to "Open configure overlay" action (index 8 in selection model)
    for (let i = 0; i < 8; i++) overlay.handleInput("\x1b[B");
    overlay.handleInput("\r"); // enter
  }));

  test("invalidate clears cached lines", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    overlay.invalidate();
    const lines2 = overlay.render(80);
    expect(lines).toEqual(lines2);
  });

  test("dispose does not throw", () => {
    const overlay = createStatusOverlay(defaultInfo, mockTheme, makeTui(), () => {});
    expect(() => overlay.dispose()).not.toThrow();
  });
});
