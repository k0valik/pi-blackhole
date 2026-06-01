import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigureOverlay } from "../src/om/configure-overlay.js";

const testDir = join(tmpdir(), "pi-blackhole-overlay-test");
const configPath = join(testDir, "pi-blackhole-config.json");

const mockTheme = {
  fg: (_style: string, text: string) => text,
};

function makeTui() {
  let _callback: (() => void) | undefined;
  return {
    requestRender: () => { _callback?.(); },
    onRender: (cb: () => void) => { _callback = cb; },
  };
}

beforeAll(() => {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    compaction: "auto",
    compactionEngine: "blackhole",
    tailBehavior: "pi-default",
    memory: true,
    compactAfterTokens: 81000,
    debug: false,
  }, null, 2) + "\n");
});

afterAll(() => {
  try { unlinkSync(configPath); } catch {}
  try { unlinkSync(join(testDir, "pi-blackhole-config.json.99999.tmp")); } catch {}
});

describe("createConfigureOverlay", () => {
  test("returns render, handleInput, invalidate, dispose", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    expect(overlay).toHaveProperty("render");
    expect(overlay).toHaveProperty("handleInput");
    expect(overlay).toHaveProperty("invalidate");
    expect(overlay).toHaveProperty("dispose");
  });

  test("render returns lines with header", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Blackhole Configuration"))).toBe(true);
  });

  test("render shows field values from config", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("auto");
    expect(joined).toContain("blackhole");
    expect(joined).toContain("pi-default");
  });

  test("down arrow navigates to next field", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    overlay.handleInput("\x1b[B"); // down
    // Should have moved selection — render should change
    const linesBefore = overlay.render(80);
    overlay.handleInput("\x1b[B"); // down again
    const linesAfter = overlay.render(80);
    // Selection indicator changes
    expect(linesAfter.join("\n")).not.toBe(linesBefore.join("\n"));
  });

  test("up arrow navigates to previous field", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    overlay.handleInput("\x1b[B"); // down
    overlay.handleInput("\x1b[B"); // down
    const linesDown = overlay.render(80);
    overlay.handleInput("\x1b[A"); // up
    const linesUp = overlay.render(80);
    expect(linesUp.join("\n")).not.toBe(linesDown.join("\n"));
  });

  test("enter toggles boolean field", () => {
    // First navigate to memory field (index 4 in FIELDS, type boolean)
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    // Navigate down to memory field (4th field, 0-indexed)
    for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
    // Toggle
    overlay.handleInput("\r");
    const lines = overlay.render(80).join("\n");
    // memory was on (true) → should now show off
    expect(lines).toContain("off");
  });

  test("helpText shows when field is selected", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    // Default selection is first field (compaction mode), should show its helpText
    const lines = overlay.render(80).join("\n");
    expect(lines).toContain("auto=trigger on threshold");
    // Navigate to tailBehavior field (index 2)
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\x1b[B");
    const lines2 = overlay.render(80).join("\n");
    expect(lines2).toContain("pi-default=keep Pi");
  });

  test("escape closes without saving", () => new Promise<void>((done) => {
    createConfigureOverlay(configPath, mockTheme, makeTui(), (result) => {
      expect(result).toBeUndefined();
      done();
    }).handleInput("\x1b");
  }));

  test("ctrl+s saves and returns OverlayResult", () => new Promise<void>((done) => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), (result) => {
      expect(result).toBeDefined();
      expect(result!.saved).toBe(true);
      expect(result!.path).toBe(configPath);
      done();
    });
    overlay.handleInput("\x13"); // ctrl+s
  }));

  test("invalidate clears cached lines", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    overlay.invalidate();
    const lines2 = overlay.render(80);
    // Both renders should produce same output for same state
    expect(lines).toEqual(lines2);
  });

  test("dispose does not throw", () => {
    const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
    expect(() => overlay.dispose()).not.toThrow();
  });

  test("handles missing config file gracefully", () => {
    const overlay = createConfigureOverlay("/nonexistent/path.json", mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    // Should still render (uses empty config)
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Blackhole Configuration"))).toBe(true);
  });
});
