import type { NormalizedBlock } from "../types";
import { clip, firstLine } from "./content";
import { extractPath } from "./tool-args";
import { collapseSkillText } from "./skill-collapse";

const TRUNCATE_USER = 256;
const TRUNCATE_ASSISTANT = 200;

// Strip common self-reflective assistant prefixes that carry no semantic info.
// Conservative list: only removes the leading filler, preserves the actual content.
const SELF_TALK_PREFIX_RE =
  /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

// ── noise filtering ──

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

// ── truncation ──

// Unicode-aware word segmentation via Intl.Segmenter with lazy init & fallback
let _segmenter: Intl.Segmenter | null | undefined = undefined;
const wordSegments = (text: string): Array<{ segment: string; index: number; isWordLike?: boolean }> => {
  // Available: fast path
  if (_segmenter) return Array.from(_segmenter.segment(text));
  // Fallback already established: don't retry the constructor
  if (_segmenter === null) {
    const parts: Array<{ segment: string; index: number; isWordLike?: boolean }> = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
  // _segmenter === undefined: first call — attempt construction
  try {
    _segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    return Array.from(_segmenter.segment(text));
  } catch {
    _segmenter = null; // permanently fallback
    const parts: Array<{ segment: string; index: number; isWordLike?: boolean }> = [];
    let idx = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      parts.push({ segment: part, index: idx, isWordLike: /\S/.test(part) });
      idx += part.length;
    }
    return parts;
  }
};

/** Check if segment is a word (Bun's isWordLike is unreliable for alphanumeric tokens) */
const isWord = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  !!seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);

// Common stop words — don't count toward budget
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

const truncateTokens = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  let count = 0;
  let lastEnd = 0;
  for (const seg of wordSegments(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) {
          return flat.slice(0, lastEnd).trimEnd() + "...(truncated)";
        }
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};

// ── bash command compression ──

const BASH_CAP = 120;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;

/** Semantic compression: strip cd prefix, pipe tail formatting, cap length */
const compressBash = (raw: string): string => {
  // Flatten multi-line: take first meaningful line
  let cmd = raw.split("\n").map(l => l.trim()).filter(Boolean)[0] ?? raw;
  // Strip cd <path> && prefix
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
  // Strip pipe tail formatting commands (up to 3 times)
  for (let i = 0; i < 3; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, "");
    if (stripped === cmd) break;
    cmd = stripped;
  }
  if (cmd.length > BASH_CAP) {
    return cmd.slice(0, BASH_CAP - 3) + "...";
  }
  return cmd;
};

// ── tool summary ──

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  read: "file_path", edit: "file_path", write: "file_path",
  Glob: "pattern", Grep: "pattern",
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") {
    return `* ${name} "${args[field] as string}"`;
  }
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (name === "bash" || name === "Bash") {
    const raw = (args.command ?? args.description ?? "") as string;
    const cmd = compressBash(raw);
    return `* ${name} "${cmd}"`;
  }
  if (typeof args.query === "string") {
    return `* ${name} "${clip(args.query as string, 60)}"`;
  }
  return `* ${name}`;
};

export interface BriefLine {
  /** Section header like "[user]", "[assistant]", "[tool_error] bash" */
  header: string;
  /** Content lines for this section */
  lines: string[];
}

/** Structured transcript entry for JSON output */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool_error";
  text?: string;
  tool?: string;
  cmd?: string;
  ref?: string;
  /** Collapse count when identical tool calls are grouped */
  count?: number;
}

/**
 * Build BriefLine sections from NormalizedBlocks.
 */
export const buildBriefSections = (blocks: NormalizedBlock[]): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = "";

  const push = (header: string, line: string) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case "user": {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[user]", text + ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const cmd = compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        if (cmd) {
          push("[user]", `$ ${cmd}${ref}`);
        }
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        // Strip leading self-talk prefix (up to 2x; assistants sometimes chain "Hmm, actually, ...")
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = truncateTokens(raw, TRUNCATE_ASSISTANT);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          push("[assistant]", text + ref);
        }
        break;
      }
      case "tool_call": {
        // Skip malformed tool calls from streaming providers (empty name / fragmented args).
        if (!b.name || b.name.trim() === "") break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        const summary = toolOneLiner(b.name, b.args) + ref;
        push("[assistant]", summary);
        break;
      }
      case "tool_result": {
        if (b.isError) {
          const body = firstLine(b.text, 150);
          // Drop empty/placeholder error bodies — keep the line only if it carries info.
          if (!body || body === "(no output)") break;
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          const header = `[tool_error] ${b.name}${ref}`;
          push(header, body);
          lastHeader = header;
        }
        break;
      }
      case "thinking":
        break;
    }
  }

  // Collapse consecutive identical tool lines (same text, different #ref)
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const out: string[] = [];
    for (const line of sec.lines) {
      if (!line.startsWith("* ")) { out.push(line); continue; }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      const base = ref ? line.slice(0, -(ref.length + 3)).trimEnd() : line;
      const last = out.length > 0 ? out[out.length - 1] : "";
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3]) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }

  // Cap tool calls per [assistant] turn — keep tail (latest actions tend to
  // be the deciding edits/writes; head is usually exploration noise).
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const toolIdxs = sec.lines
      .map((l, i) => (l.startsWith("* ") ? i : -1))
      .filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next: string[] = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }

  // Collapse consecutive identical [tool_error] sections (same tool, same body).
  // E.g. 20 back-to-back `[tool_error] bash (#N) ... Command aborted` become one
  // `[tool_error] bash (#refs...) x20` entry.
  const collapsedErrors: BriefLine[] = [];
  for (const sec of sections) {
    const m = sec.header.match(/^\[tool_error\]\s+(\S+?)(?:\s*\(#(\d+)\))?$/);
    if (!m || sec.lines.length !== 1) {
      collapsedErrors.push(sec);
      continue;
    }
    const tool = m[1];
    const ref = m[2];
    const body = sec.lines[0];
    const prev = collapsedErrors[collapsedErrors.length - 1];
    const prevMatch = prev?.header.match(
      /^\[tool_error\]\s+(\S+?)\s*\(((?:#\d+(?:,\s*)?)+)\)(?:\s*x(\d+))?$/,
    );
    if (prev && prevMatch && prevMatch[1] === tool && prev.lines.length === 1 && prev.lines[0] === body) {
      const refs = prevMatch[2] + (ref ? `, #${ref}` : "");
      const count = prevMatch[3] ? parseInt(prevMatch[3]) + 1 : 2;
      prev.header = `[tool_error] ${tool} (${refs}) x${count}`;
    } else {
      collapsedErrors.push(sec);
    }
  }
  sections.length = 0;
  sections.push(...collapsedErrors);

  return sections;
};

/**
 * Stringify BriefLine sections into text format.
 */
export const stringifyBrief = (sections: BriefLine[]): string => {

  // Emit sections -- suppress blank lines between consecutive tool summaries
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsTools = prev.header === "[assistant]" &&
        prev.lines.every((l) => l.startsWith("* "));
      const curIsTools = sec.header === "[assistant]" &&
        sec.lines.every((l) => l.startsWith("* "));
      if (!(prevIsTools && curIsTools)) {
        out.push("");
      }
    }
    out.push(sec.header);
    for (const line of sec.lines) {
      out.push(line);
    }
  }

  return out.join("\n");
};

/** Parse a text line into a structured TranscriptEntry */
const parseToolLine = (line: string): { tool: string; cmd?: string; ref?: string; count?: number } | null => {
  // * bash "cmd" (#5)
  // * bash "cmd" (#1, #3) x2
  // * tilth "query" (#7)
  const m = line.match(/^\* (\S+)\s*(?:"([^"]*)")?\s*(?:\((#[\d, #]+)\))?\s*(?:x(\d+))?$/);
  if (!m) return null;
  return {
    tool: m[1],
    cmd: m[2] || undefined,
    ref: m[3] || undefined,
    count: m[4] ? parseInt(m[4]) : undefined,
  };
};

const extractRef = (text: string): { clean: string; ref?: string } => {
  const m = text.match(/\s*\(#(\d+)\)$/);
  if (!m) return { clean: text };
  return { clean: text.slice(0, m.index).trimEnd(), ref: `#${m[1]}` };
};

/**
 * Convert BriefLine sections to structured TranscriptEntry array for JSON output.
 */
export const sectionsToTranscript = (sections: BriefLine[]): TranscriptEntry[] => {
  const entries: TranscriptEntry[] = [];

  for (const sec of sections) {
    if (sec.header === "[user]") {
      for (const line of sec.lines) {
        const { clean, ref } = extractRef(line);
        entries.push({ role: "user", text: clean, ...(ref && { ref }) });
      }
    } else if (sec.header === "[assistant]") {
      for (const line of sec.lines) {
        if (line.startsWith("* ")) {
          const parsed = parseToolLine(line);
          if (parsed) {
            entries.push({
              role: "assistant",
              tool: parsed.tool,
              ...(parsed.cmd && { cmd: parsed.cmd }),
              ...(parsed.ref && { ref: parsed.ref }),
              ...(parsed.count && { count: parsed.count }),
            });
          } else {
            // Fallback: unparseable tool line
            const { clean, ref } = extractRef(line.slice(2));
            entries.push({ role: "assistant", text: clean, ...(ref && { ref }) });
          }
        } else {
          const { clean, ref } = extractRef(line);
          entries.push({ role: "assistant", text: clean, ...(ref && { ref }) });
        }
      }
    } else if (sec.header.startsWith("[tool_error]")) {
      // [tool_error] bash (#5)
      const headerMatch = sec.header.match(/^\[tool_error\]\s+(\S+)\s*(?:\(#(\d+)\))?/);
      const tool = headerMatch?.[1] ?? "unknown";
      const ref = headerMatch?.[2] ? `#${headerMatch[2]}` : undefined;
      for (const line of sec.lines) {
        entries.push({
          role: "tool_error",
          tool,
          text: line,
          ...(ref && { ref }),
        });
      }
    }
  }

  return entries;
};

/** Convenience: build sections from blocks and stringify to text */
export const compileBrief = (blocks: NormalizedBlock[]): string =>
  stringifyBrief(buildBriefSections(blocks));
