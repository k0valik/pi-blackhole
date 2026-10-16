import type { NormalizedBlock } from "../types";
import { clip } from "../core/content";

export const ASK_TOOL = "ask_user_question";
/** Newest-wins cap on rendered decision lines per compile. */
export const MAX_DECISIONS = 8;
/** Question text clip: enough to identify the question, not its preamble. */
export const QUESTION_CLIP = 120;
/** Selected labels / custom answer clip: labels are short; this bounds a pasted essay. */
export const ANSWER_CLIP = 240;
/** User note clip: ~2-3 sentences of intent; the rest stays reachable via recall `#N`. */
export const NOTE_CLIP = 300;

interface ParsedAnswer {
  question: string;
  selected: string[];
  answer?: string;
  notes: string[];
}
interface Parsed {
  answers: ParsedAnswer[];
  globalNote?: string;
}

const flat = (s: string): string =>
  s
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fromDetails = (d: unknown): Parsed | undefined => {
  if (!d || typeof d !== "object") return;
  const r = d as { cancelled?: boolean; answers?: unknown; globalNote?: unknown };
  if (r.cancelled || !Array.isArray(r.answers)) return;
  const answers: ParsedAnswer[] = [];
  for (const a of r.answers as Record<string, any>[]) {
    if (!a || typeof a.question !== "string") continue;
    const selected = Array.isArray(a.selected)
      ? a.selected.filter((x: unknown) => typeof x === "string")
      : [];
    const notes: string[] = [];
    if (typeof a.notes === "string" && a.notes.trim()) notes.push(a.notes);
    for (const n of Array.isArray(a.optionNotes) ? a.optionNotes : []) {
      if (n && selected.includes(n.label) && typeof n.notes === "string" && n.notes.trim())
        notes.push(`note on ${n.label}: ${n.notes}`);
    }
    answers.push({
      question: a.question,
      selected,
      answer: typeof a.answer === "string" && a.answer.trim() ? a.answer : undefined,
      notes,
    });
  }
  return {
    answers,
    globalNote: typeof r.globalNote === "string" && r.globalNote.trim() ? r.globalNote : undefined,
  };
};

const HEADER_RE = /^\d+\. (.+)$/;
const STATUS_RE = /^(?:Selected: |Answer: |No option selected\.)/;
const OPTION_NOTES_RE = /^Notes for (.+) \((selected|not selected)\):$/;

/** Parse the ask_user_question text result when structured `details` is unavailable. */
const fromText = (text: string): Parsed | undefined => {
  if (!text.startsWith("User answers:")) return; // cancelled / error text → nothing
  const lines = text.split("\n");
  const answers: ParsedAnswer[] = [];
  let cur: ParsedAnswer | undefined;
  // What the current free-text body belongs to.
  let mode: "none" | "preview" | "notes" | "optnote" | "skip" | "global" = "none";
  let optLabel = "";
  let buf: string[] = [];
  let globalNote: string | undefined;
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    if (mode === "notes" && cur) cur.notes.push(body);
    else if (mode === "optnote" && cur) cur.notes.push(`note on ${optLabel}: ${body}`);
    else if (mode === "global") globalNote = body;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = HEADER_RE.exec(line);
    // A numbered line is a question only when a status line follows; notes may contain "2. foo".
    if (header && STATUS_RE.test(lines[i + 1] ?? "")) {
      flush();
      cur = { question: header[1], selected: [], notes: [] };
      answers.push(cur);
      mode = "none";
      continue;
    }
    if (!cur) continue;
    if (mode === "none" || mode === "preview" || mode === "skip") {
      if (line.startsWith("Selected: ")) {
        cur.selected = line
          .slice(10)
          .split(", ")
          .map((s) => s.trim())
          .filter(Boolean);
        mode = "none";
        continue;
      }
      if (line.startsWith("Answer: ") || line.startsWith("Custom answer: ")) {
        cur.answer = line.slice(line.indexOf(": ") + 2);
        mode = "none";
        continue;
      }
    }
    if (line === "Selected preview:") {
      flush();
      mode = "preview";
      continue;
    }
    if (line === "User notes:") {
      flush();
      mode = "notes";
      continue;
    }
    if (line === "Global note:") {
      flush();
      mode = "global";
      continue;
    }
    const on = OPTION_NOTES_RE.exec(line);
    if (on) {
      flush();
      mode = on[2] === "selected" ? "optnote" : "skip";
      optLabel = on[1];
      continue;
    }
    if (/^Attached images: \d+$/.test(line) || line.startsWith("Questions without an answer:")) {
      flush();
      mode = "skip";
      continue;
    }
    if (mode === "notes" || mode === "optnote" || mode === "global") buf.push(line);
  }
  flush();
  return { answers, globalNote };
};

/**
 * Deterministic user decisions from `ask_user_question` results. Selected
 * labels and custom answers are verbatim (clipped only against abuse); notes
 * are verbatim, flattened to one line, clipped and labelled "user note".
 * Option descriptions and previews are never emitted. Newest wins at the cap.
 */
export const extractUserDecisions = (blocks: NormalizedBlock[]): string[] => {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "tool_result" || b.name !== ASK_TOOL || b.isError) continue;
    const parsed = fromDetails((b as { details?: unknown }).details) ?? fromText(b.text);
    if (!parsed) continue;
    for (const a of parsed.answers) {
      const note = flat(a.notes.join(" / "));
      let answer = a.selected.length ? a.selected.join(", ") : (a.answer ?? "");
      if (a.selected.length && a.answer) answer += `; custom: ${a.answer}`;
      answer = flat(answer);
      if (!answer && !note) continue;
      let line = `User decided: ${clip(flat(a.question), QUESTION_CLIP)} → ${clip(answer || "(no option selected)", ANSWER_CLIP)}`;
      if (note) line += ` — user note: ${clip(note, NOTE_CLIP)}`;
      out.push(line);
    }
    const g = parsed.globalNote ? flat(parsed.globalNote) : "";
    if (g) out.push(`User note (global): ${clip(g, NOTE_CLIP)}`);
  }
  return out.slice(-MAX_DECISIONS);
};
