export type RecallScope = "lineage" | "all";
export type RecallMode = "hybrid" | "file" | "transcript";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const MODE_RE = /\bmode:(hybrid|file|transcript)\b/i;

const VALID_MODES = new Set(["hybrid", "file", "transcript"]);

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES.has(mode.toLowerCase())
    ? (mode.toLowerCase() as RecallMode)
    : "hybrid";

export const parseRecallScope = (text: string): { scope: RecallScope; mode: RecallMode; text: string } => {
  const scopeMatch = text.match(SCOPE_RE);
  const modeMatch = text.match(MODE_RE);
  return {
    scope: normalizeRecallScope(scopeMatch?.[1]),
    mode: normalizeRecallMode(modeMatch?.[1]),
    text: text.replace(SCOPE_RE, "").replace(MODE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
