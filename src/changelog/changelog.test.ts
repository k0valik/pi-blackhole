import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getOwnPackageRoot,
  getPackageVersion,
  stripMarkdownInline,
  parseChangelogEntries,
  entriesToPlainLines,
  renderChangelogEntries,
  readChangelogText,
  createChangelogViewer,
} from "./changelog.ts";

function fakeTui(rows = 24): TUI {
  return {
    terminal: { rows, columns: 80 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeTheme(): Theme {
  const passthrough = (_c: string, t: string) => t;
  return {
    fg: passthrough,
    bg: passthrough,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

describe("changelog — getOwnPackageRoot", () => {
  it("finds pi-blackhole package root", () => {
    const root = getOwnPackageRoot();
    expect(root).toBeTruthy();
    // should contain package.json with name pi-blackhole
    // reading version should succeed
    const v = getPackageVersion(root);
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("changelog — stripMarkdownInline", () => {
  it("strips bold, code, links", () => {
    expect(stripMarkdownInline("**bold** text")).toBe("bold text");
    expect(stripMarkdownInline("`code` here")).toBe("code here");
    expect(stripMarkdownInline("[link](https://example.com)")).toBe("link");
    expect(stripMarkdownInline("***bolditalic***")).toBe("bolditalic");
    expect(stripMarkdownInline("__under__")).toBe("under");
    expect(stripMarkdownInline("~~strike~~")).toBe("strike");
  });

  it("handles PR links from changelog", () => {
    const input =
      "New feature ([#65](https://github.com/k0valik/pi-blackhole/pull/65))";
    expect(stripMarkdownInline(input)).toBe("New feature (#65)");
  });
});

describe("changelog — parseChangelogEntries", () => {
  const sample = `
## [Unreleased]

---

## [0.4.9] - 2026-08-28

### Added

- First item with **bold** and \`code\`
- Second item with [link](https://example.com)

### Fixed

- Fix one

## [0.4.8] - 2026-08-23

### Changed

- Something changed
`;

  it("parses versions and sections", () => {
    const entries = parseChangelogEntries(sample);
    expect(entries.length).toBe(3);
    expect(entries[0]!.version).toBe("Unreleased");
    expect(entries[1]!.version).toBe("0.4.9");
    expect(entries[1]!.date).toBe("2026-08-28");
    expect(entries[1]!.sections.length).toBe(2);
    expect(entries[1]!.sections[0]!.heading).toBe("Added");
    expect(entries[1]!.sections[0]!.items[0]).toBe(
      "First item with bold and code",
    );
    expect(entries[1]!.sections[0]!.items[1]).toBe("Second item with link");
    expect(entries[1]!.sections[1]!.heading).toBe("Fixed");
  });

  it("respects maxEntries", () => {
    const entries = parseChangelogEntries(sample, 1);
    expect(entries.length).toBe(1);
    expect(entries[0]!.version).toBe("Unreleased");
  });

  it("round-trips through plain lines", () => {
    const entries = parseChangelogEntries(sample, 2);
    const lines = entriesToPlainLines(entries);
    expect(lines.join("\n")).toContain("## [0.4.9] - 2026-08-28");
    expect(lines.join("\n")).toContain("### Added");
    expect(lines.join("\n")).toContain("- First item");
  });

  it("renderChangelogEntries wraps without crash", () => {
    const entries = parseChangelogEntries(sample);
    const theme = fakeTheme();
    const lines = renderChangelogEntries(entries, 40, theme);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("0.4.9");
  });
});

describe("changelog — readChangelogText", () => {
  it("reads real docs/CHANGELOG.md or fallback", () => {
    const text = readChangelogText();
    // In this repo it should find docs/CHANGELOG.md
    expect(typeof text).toBe("string");
    expect(text!.length).toBeGreaterThan(100);
    expect(text!).toContain("## [");
  });

  it("returns undefined for missing package root", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-missing-"));
    try {
      const text = readChangelogText(dir);
      expect(text).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads from temporary docs/CHANGELOG.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-temp-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "pi-blackhole", version: "9.9.9" }),
      );
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(
        join(docsDir, "CHANGELOG.md"),
        "## [9.9.9] - 2026-01-01\n\n### Added\n\n- hello\n",
      );
      const text = readChangelogText(dir);
      expect(text).toContain("9.9.9");
      expect(getPackageVersion(dir)).toBe("9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("changelog — viewer component", () => {
  it("renders title with version and changelog content", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-viewer-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "pi-blackhole", version: "1.2.3" }),
      );
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(
        join(docsDir, "CHANGELOG.md"),
        "## [1.2.3] - 2026-01-02\n\n### Added\n\n- viewer test line\n",
      );
      const comp = createChangelogViewer({
        tui: fakeTui(),
        theme: fakeTheme(),
        done: () => {},
        packageRoot: dir,
      });
      const out = comp.render(80).join("\n");
      expect(out).toContain("pi-blackhole v1.2.3");
      expect(out).toContain("Changelog");
      expect(out).toContain("viewer test line");
      expect(out).toContain("Esc close");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scrolls with up/down/page keys and closes on escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-scroll-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "pi-blackhole", version: "0.0.1" }),
      );
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir, { recursive: true });
      // 30 entries to force scrolling
      let md = "";
      for (let i = 0; i < 15; i++)
        md += `## [0.0.${i}] - 2026-01-01\n\n### Added\n\n- item ${i} with a fairly long description that will wrap across lines to test scrolling behavior\n\n`;
      writeFileSync(join(docsDir, "CHANGELOG.md"), md);
      const tui = fakeTui(20);
      let closed = false;
      const comp = createChangelogViewer({
        tui,
        theme: fakeTheme(),
        done: () => {
          closed = true;
        },
        packageRoot: dir,
      });
      // initial render shows some content
      const out1 = comp.render(60).join("\n");
      expect(out1).toContain("item 0");
      // scroll down
      comp.handleInput?.("\x1b[B"); // down
      expect(tui.requestRender).toHaveBeenCalled();
      const out2 = comp.render(60).join("\n");
      // after scrolling, still renders frame chrome
      expect(out2).toContain("╭");
      // pageDown
      comp.handleInput?.("\x1b[6~");
      // escape closes
      comp.handleInput?.("\x1b");
      expect(closed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows fallback when changelog missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-fallback-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "pi-blackhole", version: "0.0.2" }),
      );
      const comp = createChangelogViewer({
        tui: fakeTui(),
        theme: fakeTheme(),
        done: () => {},
        packageRoot: dir,
      });
      const out = comp.render(60).join("\n");
      expect(out).toContain("Changelog not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
