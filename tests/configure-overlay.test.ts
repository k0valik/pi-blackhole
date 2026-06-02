import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigureOverlay } from "../src/om/configure-overlay.js";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";

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
  setKittyProtocolActive(true);
});

afterAll(() => {
  try { unlinkSync(configPath); } catch {}
  try { unlinkSync(join(testDir, "pi-blackhole-config.json.99999.tmp")); } catch {}
  setKittyProtocolActive(false);
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

  // -------------------------------------------------------------------------
  // Kitty keyboard protocol (CSI-u) tests
  // -------------------------------------------------------------------------
  describe("Kitty CSI-u input", () => {
    test("escape via CSI-u closes without saving", () => new Promise<void>((done) => {
      createConfigureOverlay(configPath, mockTheme, makeTui(), (result) => {
        expect(result).toBeUndefined();
        setKittyProtocolActive(true);
        done();
      }).handleInput("\x1b[27u");
    }));

    test("ctrl+s via CSI-u saves and returns OverlayResult", () => new Promise<void>((done) => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), (result) => {
        expect(result).toBeDefined();
        expect(result!.saved).toBe(true);
        expect(result!.path).toBe(configPath);
        done();
      });
      overlay.handleInput("\x1b[115;5u"); // Kitty ctrl+s
    }));

    test("down arrow via CSI-u navigates to next field", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      overlay.handleInput("\x1b[1;1B"); // Kitty down (CSI arrow with modifier)
      const linesBefore = overlay.render(80);
      overlay.handleInput("\x1b[1;1B"); // down again
      const linesAfter = overlay.render(80);
      expect(linesAfter.join("\n")).not.toBe(linesBefore.join("\n"));
    });

    test("up arrow via CSI-u navigates to previous field", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      overlay.handleInput("\x1b[1;1B"); // down
      overlay.handleInput("\x1b[1;1B"); // down
      const linesDown = overlay.render(80);
      overlay.handleInput("\x1b[1;1A"); // Kitty up
      const linesUp = overlay.render(80);
      expect(linesUp.join("\n")).not.toBe(linesDown.join("\n"));
    });

    test("enter via CSI-u toggles boolean field", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      // Navigate down to memory field (index 4, boolean, initially on)
      for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[1;1B");
      // Verify it's showing "on" before toggle
      const before = overlay.render(80).join("\n");
      expect(before).toContain("Observational memory");
      overlay.handleInput("\x1b[13u"); // Kitty enter
      const after = overlay.render(80).join("\n");
      // After toggling memory from on→off, render output should differ
      expect(after).not.toBe(before);
    });

    test("backspace via CSI-u works in number editing", () => new Promise<void>((resolve) => {
      let stage = 0;
      const done = () => {};
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), done);
      // Navigate to compactAfterTokens (index 3, number field)
      for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[1;1B");
      overlay.handleInput("\x1b[13u"); // Kitty enter → start editing
      const origLength = overlay.render(80).join("\n");
      overlay.handleInput("\x1b[127u"); // Kitty backspace
      const after = overlay.render(80).join("\n");
      // Backspace should change the rendered value
      expect(after).not.toBe(origLength);
      resolve();
    }));

    test("digit via CSI-u works in number editing", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      // Navigate to compactAfterTokens (index 3, number field)
      for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[1;1B");
      overlay.handleInput("\x1b[13u"); // Kitty enter → start editing
      overlay.handleInput("\x1b[127u"); // backspace to clear
      overlay.handleInput("\x1b[48u"); // Kitty '0'
      overlay.handleInput("\x1b[49u"); // Kitty '1'
      const lines = overlay.render(80).join("\n");
      // Should show "01" somewhere in the output
      expect(lines).toContain("01");
    });

    test("tab via CSI-u exits edit mode", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      // Navigate to compactAfterTokens (index 3, number field)
      for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[1;1B");
      overlay.handleInput("\x1b[13u"); // Kitty enter → start editing
      const editingOutput = overlay.render(80).join("\n");
      overlay.handleInput("\x1b[9u"); // Kitty tab → exit edit
      const afterTab = overlay.render(80).join("\n");
      // Exiting edit mode should change the render (cursor disappears)
      expect(afterTab).not.toBe(editingOutput);
    });

    test("space via CSI-u toggles boolean", () => {
      const overlay = createConfigureOverlay(configPath, mockTheme, makeTui(), () => {});
      // Navigate to memory field (index 4, boolean, initially on)
      for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[1;1B");
      const before = overlay.render(80).join("\n");
      overlay.handleInput("\x1b[32u"); // Kitty space
      const after = overlay.render(80).join("\n");
      // Toggle should change render output
      expect(after).not.toBe(before);
    });
  });

  test("handles missing config file gracefully", () => {
    const overlay = createConfigureOverlay("/nonexistent/path.json", mockTheme, makeTui(), () => {});
    const lines = overlay.render(80);
    // Should still render (uses empty config)
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Blackhole Configuration"))).toBe(true);
  });
});
