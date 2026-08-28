/**
 * Changelog viewer — reads CHANGELOG.md from the package root and renders
 * it inside a scrollable framed overlay.
 *
 * Tier 1 only: plain-text via existing frame primitives. No Markdown
 * component dependency.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  frame,
  frameContentWidth,
  responsiveInnerRows,
  wrapLine,
} from "../pi-base/settings/frame.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface ChangelogSection {
  heading: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: ChangelogSection[];
}

// Inlined at bundle time via tsup esbuild plugin (see tsup.config.ts).
// Keeps dist/ self-contained when tsup clean:true removes the source
// .md files. In TS-direct mode (jiti) this stays undefined and the
// filesystem path is used instead.
const BUNDLED_CHANGELOG_TEXT: string | undefined = undefined;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Walk up from `import.meta.url` (or cwd fallback) to find pi-blackhole package root. */
export function getOwnPackageRoot(): string {
  // Try import.meta.url first — works in both TS-direct and bundled dist.
  try {
    const metaUrl = import.meta.url as string | undefined;
    if (typeof metaUrl === "string" && metaUrl.length > 0) {
      let dir = dirname(fileURLToPath(metaUrl));
      while (dir !== dirname(dir)) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
            name?: string;
          };
          if (pkg.name === "pi-blackhole") return dir;
        } catch {
          /* walk up */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* fallback */
  }

  // Fallback: walk up from cwd
  try {
    let dir = process.cwd();
    while (dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "pi-blackhole") return dir;
      } catch {
        /* walk up */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fallback */
  }

  // Fallback: argv[1]
  try {
    const entry = process.argv[1];
    if (entry) {
      let dir = dirname(entry);
      while (dir !== dirname(dir)) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
            name?: string;
          };
          if (pkg.name === "pi-blackhole") return dir;
        } catch {
          /* walk up */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* fallback */
  }

  return process.cwd();
}

export function getPackageVersion(packageRoot?: string): string | undefined {
  const root = packageRoot ?? getOwnPackageRoot();
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Strip common inline markdown: links, bold, italic, code, strikethrough. */
export function stripMarkdownInline(text: string): string {
  let s = text;
  // Links: [text](url) → text  (must run before ** / ` stripping)
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Inline code: `code` → code
  s = s.replace(/`([^`]+)`/g, "$1");
  // Bold+italic: ***text*** → text
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  // Bold: **text** → text
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  // Bold alt: __text__ → text
  s = s.replace(/__([^_]+)__/g, "$1");
  // Italic: *text* → text  (single * not part of **)
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  // Italic alt: _text_ → text (avoid matching inside words)
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
  // Strikethrough: ~~text~~ → text
  s = s.replace(/~~([^~]+)~~/g, "$1");
  return s;
}

/** Read raw CHANGELOG.md text from package root (tries CHANGELOG.md then docs/CHANGELOG.md). */
export function readChangelogText(packageRoot?: string): string | undefined {
  const explicitRoot = packageRoot !== undefined;
  const root = packageRoot ?? getOwnPackageRoot();
  const candidates = [join(root, "CHANGELOG.md"), join(root, "docs/CHANGELOG.md")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch {
      /* try next */
    }
  }
  if (explicitRoot) return undefined;
  // Fallback: cwd-relative docs/CHANGELOG.md
  try {
    const fallback = join(process.cwd(), "docs/CHANGELOG.md");
    if (existsSync(fallback)) return readFileSync(fallback, "utf-8");
  } catch {
    /* ignore */
  }
  return BUNDLED_CHANGELOG_TEXT ?? undefined;
}

/**
 * Parse a Keep-a-Changelog style markdown file into entries.
 * Each entry starts with `## [version] - date` or `## [version]`.
 */
export function parseChangelogEntries(text: string, maxEntries?: number): ChangelogEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | undefined;
  let currentSection: ChangelogSection | undefined;

  const versionRe = /^##\s+\[([^\]]+)\]\s*-?\s*(.*)\s*$/;
  const sectionRe = /^###\s+(.+)\s*$/;
  const bulletRe = /^\s*-\s+(.*)\s*$/;

  for (const raw of lines) {
    const versionMatch = raw.match(versionRe);
    if (versionMatch) {
      if (current) entries.push(current);
      current = {
        version: versionMatch[1]!.trim(),
        date: versionMatch[2]!.trim() || undefined,
        sections: [],
      };
      currentSection = undefined;
      if (maxEntries !== undefined && entries.length >= maxEntries) {
        // We've collected enough completed entries; allow filling current
        // but stop after it completes. Simpler: push and slice at end.
      }
      continue;
    }
    if (!current) continue;

    const sectionMatch = raw.match(sectionRe);
    if (sectionMatch) {
      currentSection = {
        heading: stripMarkdownInline(sectionMatch[1]!.trim()),
        items: [],
      };
      current.sections.push(currentSection);
      continue;
    }

    const bulletMatch = raw.match(bulletRe);
    if (bulletMatch && currentSection) {
      currentSection.items.push(stripMarkdownInline(bulletMatch[1]!.trim()));
      continue;
    }
    // Continuation lines for bullet items (indented)
    if (
      currentSection &&
      currentSection.items.length > 0 &&
      raw.length > 0 &&
      /^\s{2,}\S/.test(raw) &&
      !raw.startsWith("##") &&
      !raw.startsWith("###")
    ) {
      const last = currentSection.items.length - 1;
      currentSection.items[last] =
        `${currentSection.items[last]} ${stripMarkdownInline(raw.trim())}`;
    }
  }
  if (current) entries.push(current);

  if (maxEntries !== undefined) return entries.slice(0, maxEntries);
  return entries;
}

/**
 * Convert parsed entries into display lines (unwrapped).
 * Caller should wrap to contentWidth before framing.
 */
export function entriesToPlainLines(entries: ChangelogEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const header = entry.date ? `## [${entry.version}] - ${entry.date}` : `## [${entry.version}]`;
    out.push(header);
    out.push("");
    if (entry.sections.length === 0) {
      out.push("(no details)");
      out.push("");
      continue;
    }
    for (const sec of entry.sections) {
      out.push(`### ${sec.heading}`);
      if (sec.items.length === 0) {
        out.push("(no items)");
      } else {
        for (const item of sec.items) {
          out.push(`- ${item}`);
        }
      }
      out.push("");
    }
  }
  return out;
}

/**
 * Render changelog entries into wrapped lines for a given width.
 * Uses theme for version header accent; wraps bullets with continuation indent.
 */
export function renderChangelogEntries(
  entries: ChangelogEntry[],
  width: number,
  theme: Theme,
): string[] {
  const plain = entriesToPlainLines(entries);
  const wrapped: string[] = [];
  for (const line of plain) {
    if (line.startsWith("## [")) {
      // Version header — accent + bold
      const styled = theme.fg("accent", theme.bold(line));
      // wrapLine will strip ANSI width correctly
      wrapped.push(...wrapLine(styled, width));
    } else if (line.startsWith("### ")) {
      wrapped.push(...wrapLine(theme.fg("accent", line), width));
    } else if (line.startsWith("- ")) {
      // Bullet: wrap then indent continuation by 2 spaces
      const chunks = wrapLine(line, width);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) wrapped.push(chunks[i]!);
        else wrapped.push(`  ${chunks[i]}`);
      }
    } else if (line === "") {
      wrapped.push("");
    } else {
      wrapped.push(...wrapLine(line, width));
    }
  }
  return wrapped;
}

// ── Viewer Component ─────────────────────────────────────────────────────

const PREFERRED_INNER_ROWS = 45;

export interface ChangelogViewerArgs {
  tui: TUI;
  theme: Theme;
  done: (result: void) => void;
  packageRoot?: string;
  maxEntries?: number;
}

export function createChangelogViewer(args: ChangelogViewerArgs): Component {
  const { tui, theme, done, packageRoot, maxEntries } = args;

  const version = getPackageVersion(packageRoot);
  const title = version ? `pi-blackhole v${version} — Changelog` : "pi-blackhole — Changelog";

  const raw = readChangelogText(packageRoot);
  let allLines: string[];

  if (!raw) {
    allLines = ["Changelog not found.", "Expected CHANGELOG.md at package root."];
  } else {
    const entries = parseChangelogEntries(raw, maxEntries);
    if (entries.length === 0) {
      // Fallback: show raw stripped lines wrapped
      const stripped = raw.split(/\r?\n/).map((l) => stripMarkdownInline(l));
      allLines = stripped;
    } else {
      // Defer wrapping to render() so it reacts to width, but precompute
      // unwrapped plain lines then wrap per render width.
      // For scroll we need wrapped lines at render time; store entries instead.
      // To simplify, compute with a default width and recompute on render if needed.
      // Here we store plain entries and wrap lazily in render().
      // We keep allLines as placeholder; actual wrapping happens in render().
      // Easier: store entries and derive allLines in render() via closure.
      // We store entries and produce wrapped lines on each render.
      const entriesRef = entries;
      // Return early with lazy component
      return createLazyChangelogViewer({
        tui,
        theme,
        done,
        title,
        entries: entriesRef,
      });
    }
  }

  // Non-entry fallback path (no entries): static lines
  let scroll = 0;
  const PAGE = 5;

  const render = (width: number): string[] => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
    const cw = frameContentWidth(width);
    // Wrap static lines to current width
    const wrapped: string[] = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");

    const body: string[] = [];
    if (scroll > 0) body.push(theme.fg("dim", `  ↑ ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  ↓ ${wrapped.length - scroll - visible} more`));
    }

    const hints = "↑↓ scroll · PgUp/PgDn · Esc close";
    const footer = theme.fg("dim", hints);
    // Reserve one footer line inside frame: append after body before framing?
    // Simpler: include footer as last body line dim
    const withFooter = [...body, "", footer];
    return frame(withFooter, width, theme, {
      title,
      fixedInnerRows: inner,
    });
  };

  const handleInput = (data: string): void => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
    const cw = frameContentWidth(80); // temp; actual wrapped length uses cw=?
    // Recompute wrapped length for bounds
    const wrapped: string[] = [];
    for (const line of allLines) {
      if (line === "") wrapped.push("");
      else wrapped.push(...wrapLine(line, cw));
    }
    // For accurate bounds we need current width; we approximate with 80.
    // Real render will clamp. Use dynamic width if tui provides it? tui stores last width implicitly.
    // Better: compute maxScroll from wrapped length vs visible
    const visible = Math.max(1, inner - 2);
    const maxScroll = Math.max(0, wrapped.length - visible);

    if (matchesKey(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done();
    }
  };

  return { render, handleInput, invalidate: () => {} };
}

function createLazyChangelogViewer(params: {
  tui: TUI;
  theme: Theme;
  done: (r: void) => void;
  title: string;
  entries: ChangelogEntry[];
}): Component {
  const { tui, theme, done, title, entries } = params;
  let scroll = 0;
  const PAGE = 5;
  let lastWidth = 80;
  let cachedWrapped: string[] = [];

  function getWrapped(width: number): string[] {
    if (width === lastWidth && cachedWrapped.length > 0) return cachedWrapped;
    lastWidth = width;
    const cw = frameContentWidth(width);
    cachedWrapped = renderChangelogEntries(entries, cw, theme);
    return cachedWrapped;
  }

  const render = (width: number): string[] => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
    const wrapped = getWrapped(width);
    const visible = Math.max(1, inner - 3); // reserve footer + blank
    const maxScroll = Math.max(0, wrapped.length - visible);
    scroll = Math.min(scroll, maxScroll);
    const slice = wrapped.slice(scroll, scroll + visible);
    while (slice.length < visible) slice.push("");

    const body: string[] = [];
    if (scroll > 0) body.push(theme.fg("dim", `  ↑ ${scroll} earlier`));
    body.push(...slice);
    if (scroll + visible < wrapped.length) {
      body.push(theme.fg("dim", `  ↓ ${wrapped.length - scroll - visible} more`));
    }
    body.push("");
    body.push(theme.fg("dim", "  ↑↓ scroll · PgUp/PgDn · Esc close"));
    return frame(body, width, theme, { title, fixedInnerRows: inner });
  };

  const handleInput = (data: string): void => {
    const inner = responsiveInnerRows(tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
    const wrapped = getWrapped(lastWidth);
    const visible = Math.max(1, inner - 3);
    const maxScroll = Math.max(0, wrapped.length - visible);

    if (matchesKey(data, "up")) {
      scroll = Math.max(0, scroll - 1);
      tui.requestRender();
    } else if (matchesKey(data, "down")) {
      scroll = Math.min(maxScroll, scroll + 1);
      tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      scroll = Math.max(0, scroll - PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      scroll = Math.min(maxScroll, scroll + PAGE);
      tui.requestRender();
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      done();
    }
  };

  return { render, handleInput, invalidate: () => {} };
}

/** Open the changelog as an overlay via ctx.ui.custom. */
export async function openChangelogView(ctx: ExtensionContext): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => createChangelogViewer({ tui, theme, done: () => done(undefined) }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" },
    },
  );
}
