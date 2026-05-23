export type RecallScope = "lineage" | "all";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
  const match = text.match(SCOPE_RE);
  return {
    scope: normalizeRecallScope(match?.[1]),
    text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
