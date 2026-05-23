import type { Message } from "@earendil-works/pi-ai";

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

/**
 * Clip text to last sentence boundary at or before `max` chars.
 * Falls back to word boundary (clip()) if no sentence end is found in the
 * acceptable range. Trailing whitespace stripped.
 */
export const clipSentence = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Look for sentence terminators followed by space/newline within [max*0.5, max]
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1; // include the punctuation
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};

export const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text: string, max = 200): string =>
  clip(text.split("\n")[0] ?? "", max);

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");

/** Extract a snippet of ~`radius` chars around the first match of `term` in `text`. */
export const snippet = (text: string, term: string, radius = 60): string | null => {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};
