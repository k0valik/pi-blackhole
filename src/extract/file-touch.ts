/**
 * File-touch attribution — which files did the agent actually mutate in this session?
 *
 * Ported from k0valik/pi-files-touched (files-touched-core.ts), adapted to
 * blackhole's pipeline:
 *  - operates on `Message[]` (pi-ai) instead of SessionEntry[], so it runs on
 *    the raw pre-conversion messages already available at compaction time;
 *  - the bash shell tokenizer/parser, rp/rp_exec parsing, no-op edit
 *    suppression, move redirects and path normalization are kept verbatim;
 *  - anchor-based edit tools (pi-hashline-edit-pro `replace`/`insert`) carry no
 *    path in their arguments — the resolved path is recovered from the tool
 *    result text ("Successfully replaced in <path>.", "Successfully wrote N
 *    bytes to <path>.");
 *  - no git-root/display machinery: callers get canonical paths and use their
 *    own display trimming (see src/extract/files.ts longestCommonDirPrefix).
 *
 * Runs only during compaction (via buildSections), never per tool call.
 */
import path from "node:path";

import type { Message } from "@earendil-works/pi-ai";

export type FileTouchOperation = "read" | "write" | "edit" | "move" | "delete";

export interface FilesTouchedEntry {
  path: string;
  operations: Set<FileTouchOperation>;
  /** Operation applied most recently — used to drop files deleted later in the session. */
  lastOperation: FileTouchOperation;
  lastTimestamp: number;
}

type FileMove = {
  from: string;
  to: string;
};

type FileTrackingAction =
  | { kind: "touch"; path: string; operation: FileTouchOperation }
  | { kind: "move"; from: string; to: string };

type TrackedTouchRecord = {
  path: string;
  operation: FileTouchOperation;
  timestamp: number;
};

type ParsedRootPrefixedPath = {
  root: string;
  relativePath: string;
};

type RootInfo = {
  absolutePath: string;
  name: string;
};

function uniqStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeSegments(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const normalized = normalizePathSeparators(value);
  const segments: string[] = [];

  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function normalizeRelativePath(value: string): string {
  return normalizeSegments(value.trim());
}

function normalizeAbsolutePath(value: string): string {
  const normalized = normalizePathSeparators(value.trim());
  const windowsMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
  if (windowsMatch) {
    const segments = normalizeSegments(windowsMatch[2] || "");
    return segments ? `${windowsMatch[1]}/${segments}` : `${windowsMatch[1]}/`;
  }

  const segments = normalizeSegments(normalized);
  return segments ? `/${segments}` : "/";
}

function isAbsolutePath(value: string): boolean {
  const normalized = normalizePathSeparators(value.trim());
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

function stripReadSliceSuffix(value: string): string {
  return value.replace(/:(\d+)-(\d+)$/, "");
}

function firstDefinedString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function parseRootPrefixedPath(value: string): ParsedRootPrefixedPath | null {
  const normalized = normalizePathSeparators(value.trim());
  if (!normalized || isAbsolutePath(normalized)) {
    return null;
  }

  const match = normalized.match(/^([^/:]+):(.*)$/);
  if (!match) {
    return null;
  }

  const root = match[1];
  if (/^[A-Za-z]$/.test(root)) {
    return null;
  }

  const relativePath = normalizeRelativePath(match[2]);
  if (!relativePath) {
    return null;
  }

  return {
    root,
    relativePath,
  };
}

function splitPathSegments(value: string): string[] {
  return normalizePathSeparators(value).split("/").filter(Boolean);
}

function deriveRootFromAbsoluteAndRelative(absPath: string, relativePath: string): string | null {
  const absSegments = splitPathSegments(normalizeAbsolutePath(absPath));
  const relSegments = splitPathSegments(normalizeRelativePath(relativePath));
  if (relSegments.length === 0 || absSegments.length <= relSegments.length) {
    return null;
  }

  for (let index = 1; index <= relSegments.length; index += 1) {
    if (absSegments[absSegments.length - index] !== relSegments[relSegments.length - index]) {
      return null;
    }
  }

  const derivedSegments = absSegments.slice(0, absSegments.length - relSegments.length);
  const firstSegment = derivedSegments[0] || "";
  if (/^[A-Za-z]:$/.test(firstSegment)) {
    return derivedSegments.join("/");
  }
  return `/${derivedSegments.join("/")}`;
}

function inferRootMappings(paths: string[]): Map<string, string> {
  const absolutePaths = uniqStrings(
    paths.filter((value) => isAbsolutePath(value)).map((value) => normalizeAbsolutePath(value)),
  );
  const rootRefs = paths
    .map((value) => parseRootPrefixedPath(value))
    .filter((value): value is ParsedRootPrefixedPath => Boolean(value));
  const scoresByRoot = new Map<string, Map<string, number>>();

  for (const ref of rootRefs) {
    const rootScores = scoresByRoot.get(ref.root) ?? new Map<string, number>();
    for (const absolutePath of absolutePaths) {
      const candidateRoot = deriveRootFromAbsoluteAndRelative(absolutePath, ref.relativePath);
      if (!candidateRoot) {
        continue;
      }

      const bonus = path.basename(candidateRoot) === ref.root ? 2 : 1;
      rootScores.set(candidateRoot, (rootScores.get(candidateRoot) ?? 0) + bonus);
    }

    scoresByRoot.set(ref.root, rootScores);
  }

  const out = new Map<string, string>();
  for (const [root, scores] of scoresByRoot) {
    const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
    if (ranked.length === 0) {
      continue;
    }

    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      continue;
    }

    out.set(root, ranked[0][0]);
  }

  return out;
}

function getCurrentRootInfo(cwd: string | null | undefined): RootInfo | null {
  if (!cwd || !isAbsolutePath(cwd)) {
    return null;
  }

  const absolutePath = normalizeAbsolutePath(cwd);
  return {
    absolutePath,
    name: path.basename(absolutePath),
  };
}

function buildRootMappings(paths: string[], currentRoot: RootInfo | null): Map<string, string> {
  const mappings = inferRootMappings(paths);
  if (currentRoot) {
    mappings.set(currentRoot.name, currentRoot.absolutePath);
  }
  return mappings;
}

function isWithinPath(filePath: string, rootPath: string): boolean {
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function findRootForAbsolutePath(
  absolutePath: string,
  rootMappings: Map<string, string>,
): { root: string; relativePath: string } | null {
  const normalizedAbsolutePath = normalizeAbsolutePath(absolutePath);
  let bestMatch: { root: string; relativePath: string; rootPathLength: number } | null = null;

  for (const [root, rootPath] of rootMappings) {
    if (!isWithinPath(normalizedAbsolutePath, rootPath) || normalizedAbsolutePath === rootPath) {
      continue;
    }

    const relativePath = normalizedAbsolutePath.slice(rootPath.length + 1);
    if (!relativePath) {
      continue;
    }

    if (!bestMatch || rootPath.length > bestMatch.rootPathLength) {
      bestMatch = { root, relativePath, rootPathLength: rootPath.length };
    }
  }

  return bestMatch ? { root: bestMatch.root, relativePath: bestMatch.relativePath } : null;
}

function normalizeTrackedPath(
  pathValue: string,
  rootMappings: Map<string, string>,
  currentRoot: RootInfo | null,
  sortedRootKeys?: string[],
): string {
  const strippedPath = stripReadSliceSuffix(pathValue.trim());
  if (!strippedPath) {
    return "";
  }

  const rootPrefixed = parseRootPrefixedPath(strippedPath);
  if (rootPrefixed) {
    return `${rootPrefixed.root}:${rootPrefixed.relativePath}`;
  }

  if (isAbsolutePath(strippedPath)) {
    const rooted = findRootForAbsolutePath(strippedPath, rootMappings);
    return rooted ? `${rooted.root}:${rooted.relativePath}` : normalizeAbsolutePath(strippedPath);
  }

  let relativePath = strippedPath;
  if (
    currentRoot &&
    (relativePath === currentRoot.name || relativePath.startsWith(`${currentRoot.name}/`))
  ) {
    relativePath =
      relativePath === currentRoot.name ? "" : relativePath.slice(currentRoot.name.length + 1);
  }

  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (!normalizedRelativePath) {
    return currentRoot?.absolutePath ?? "";
  }

  const keys =
    sortedRootKeys ?? [...rootMappings.keys()].sort((left, right) => right.length - left.length);
  const rootedRelative = keys.find((root) => normalizedRelativePath.startsWith(`${root}/`));
  if (rootedRelative) {
    return `${rootedRelative}:${normalizedRelativePath.slice(rootedRelative.length + 1)}`;
  }

  return currentRoot ? `${currentRoot.name}:${normalizedRelativePath}` : normalizedRelativePath;
}

function resolveCanonicalPath(
  canonicalPath: string,
  rootMappings: Map<string, string>,
  currentRoot: RootInfo | null,
): string {
  if (!canonicalPath) {
    return canonicalPath;
  }

  if (isAbsolutePath(canonicalPath)) {
    return normalizeAbsolutePath(canonicalPath);
  }

  const rootPrefixed = parseRootPrefixedPath(canonicalPath);
  if (rootPrefixed) {
    const rootPath =
      rootMappings.get(rootPrefixed.root) ??
      (currentRoot?.name === rootPrefixed.root ? currentRoot.absolutePath : null);
    if (!rootPath) {
      return canonicalPath;
    }

    return `${rootPath}/${rootPrefixed.relativePath}`;
  }

  const normalizedRelativePath = normalizeRelativePath(canonicalPath);
  if (!normalizedRelativePath) {
    return currentRoot?.absolutePath ?? canonicalPath;
  }

  return currentRoot
    ? `${currentRoot.absolutePath}/${normalizedRelativePath}`
    : normalizedRelativePath;
}

function resolveMoveRedirect(pathValue: string, redirects: Map<string, string>): string {
  let current = pathValue;
  const seen = new Set<string>();

  while (redirects.has(current) && !seen.has(current)) {
    seen.add(current);
    current = redirects.get(current) ?? current;
  }

  return current;
}

function extractJsonObject(text: string, prefix: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const jsonText = trimmed.slice(prefix.length).trim();
  if (!jsonText.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Like extractJsonObject but searches for the prefix anywhere in the text. */
function extractJsonObjectAnywhere(text: string, prefix: string): Record<string, unknown> | null {
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  const after = text.slice(idx + prefix.length).trim();
  if (!after.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(after);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractFileActionsFromJson(args: Record<string, unknown>): FileTrackingAction | null {
  const action = typeof args.action === "string" ? args.action : "";
  const targetPath = typeof args.path === "string" ? args.path : null;
  const newPath = typeof args.new_path === "string" ? args.new_path : null;
  if (action === "create" && targetPath) {
    return { kind: "touch", path: targetPath, operation: "write" };
  }
  if (action === "delete" && targetPath) {
    return { kind: "touch", path: targetPath, operation: "delete" };
  }
  if (action === "move" && targetPath && newPath) {
    return { kind: "move", from: targetPath, to: newPath };
  }
  return null;
}

function actionAlreadyCaptured(
  existing: FileTrackingAction[],
  action: FileTrackingAction,
): boolean {
  for (const a of existing) {
    if (a.kind !== action.kind) continue;
    if (a.kind === "move" && action.kind === "move") {
      if (a.from === action.from && a.to === action.to) return true;
    } else if (a.kind === "touch" && action.kind === "touch") {
      if (a.path === action.path && a.operation === action.operation) return true;
    }
  }
  return false;
}

function extractCliNamedArg(cmd: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cmd.match(new RegExp(`(?:^|\\s)${escapedKey}=(?:"([^"]+)"|'([^']+)'|(\\S+))`));
  return firstDefinedString(...(match?.slice(1) ?? []));
}

function commandStartsWith(cmd: string, name: string): boolean {
  const trimmed = cmd.trim();
  return trimmed === name || trimmed.startsWith(`${name} `);
}

function extractReadPathFromCliCommand(cmd: string): string | null {
  const readFileMatch = cmd.match(/(?:^|\s)read_file\s+.*?\bpath=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (readFileMatch) {
    return stripReadSliceSuffix(firstDefinedString(...readFileMatch.slice(1)) ?? "");
  }

  const simpleReadMatch = cmd.match(/^(?:read|cat)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (simpleReadMatch) {
    return stripReadSliceSuffix(firstDefinedString(...simpleReadMatch.slice(1)) ?? "");
  }

  return null;
}

function tokenizeShellCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < cmd.length; index += 1) {
    const char = cmd[index];
    const next = cmd[index + 1] ?? "";

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote) {
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "\r" || char === "\n") {
      flush();
      tokens.push(";");
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    if (char === ";") {
      flush();
      tokens.push(char);
      continue;
    }

    if ((char === "&" || char === "|") && next === char) {
      flush();
      tokens.push(char + next);
      index += 1;
      continue;
    }

    if (char === "&" || char === "|") {
      flush();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  flush();
  return tokens;
}

function splitShellCommands(cmd: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];

  for (const token of tokenizeShellCommand(cmd)) {
    if (token === ";" || token === "&&" || token === "||" || token === "|" || token === "&") {
      if (current.length > 0) {
        commands.push(current);
        current = [];
      }
      continue;
    }

    current.push(token);
  }

  if (current.length > 0) {
    commands.push(current);
  }

  return commands;
}

function stripShellCommandWrappers(tokens: string[]): string[] {
  let current = [...tokens];

  while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(current[0])) {
    current = current.slice(1);
  }

  for (const wrapper of ["command", "env", "noglob", "sudo"]) {
    if (current[0] !== wrapper) {
      continue;
    }

    current = current.slice(1);
    while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(current[0])) {
      current = current.slice(1);
    }
  }

  return current;
}

function extractShellOperands(tokens: string[]): string[] {
  const operands: string[] = [];
  let allowFlags = true;

  for (const token of tokens) {
    if (allowFlags && token === "--") {
      allowFlags = false;
      continue;
    }

    if (allowFlags && token.startsWith("-")) {
      continue;
    }

    operands.push(token);
  }

  return operands;
}

function extractHeadTailReadOperands(tokens: string[]): string[] {
  const operands: string[] = [];
  let allowFlags = true;
  let skipNextOptionValue = false;

  for (const token of tokens) {
    if (skipNextOptionValue) {
      skipNextOptionValue = false;
      continue;
    }

    if (allowFlags && token === "--") {
      allowFlags = false;
      continue;
    }

    if (
      allowFlags &&
      (token === "-n" || token === "-c" || token === "--lines" || token === "--bytes")
    ) {
      skipNextOptionValue = true;
      continue;
    }

    if (allowFlags && (token.startsWith("-") || /^[+]\d+[bcflkm]?$/.test(token))) {
      continue;
    }

    operands.push(token);
  }

  return operands;
}

function isIgnoredRedirectTarget(value: string): boolean {
  return value === "/dev/null" || value === "/dev/stderr" || value === "/dev/stdout";
}

function isLiteralShellPathOperand(value: string): boolean {
  return !/[`$]/.test(value) && !value.startsWith("<(") && !value.startsWith(">(");
}

function pushShellTouch(
  actions: FileTrackingAction[],
  pathValue: string,
  operation: FileTouchOperation,
): void {
  if (isLiteralShellPathOperand(pathValue)) {
    actions.push({ kind: "touch", path: pathValue, operation });
  }
}

function pushShellMove(actions: FileTrackingAction[], from: string, to: string): void {
  if (isLiteralShellPathOperand(from) && isLiteralShellPathOperand(to)) {
    actions.push({ kind: "move", from, to });
  }
}

function extractRedirectWriteTargets(tokens: string[], actions: FileTrackingAction[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === ">" || token === ">>" || token === "2>" || token === "2>>") {
      if (i + 1 < tokens.length && !isIgnoredRedirectTarget(tokens[i + 1])) {
        if (tokens[i + 1] === "|") {
          if (i + 2 < tokens.length && !isIgnoredRedirectTarget(tokens[i + 2])) {
            pushShellTouch(actions, tokens[i + 2], "write");
          }
          i += 2;
        } else {
          pushShellTouch(actions, tokens[i + 1], "write");
          i += 1;
        }
      } else {
        i += 1;
      }
      continue;
    }

    if (
      (token.startsWith(">>") || token.startsWith("2>>")) &&
      token.length > (token.startsWith("2") ? 3 : 2)
    ) {
      const target = token.slice(token.startsWith("2") ? 3 : 2);
      if (!isIgnoredRedirectTarget(target)) {
        pushShellTouch(actions, target, "write");
      }
      continue;
    }

    if (
      (token.startsWith(">") || token.startsWith("2>")) &&
      token.length > (token.startsWith("2") ? 2 : 1)
    ) {
      const target = token.slice(token.startsWith("2") ? 2 : 1);
      if (!isIgnoredRedirectTarget(target)) {
        pushShellTouch(actions, target, "write");
      }
      continue;
    }
  }
}

function looksLikeSedExpression(value: string): boolean {
  return (
    /^[sy]([^A-Za-z0-9\s]).*?\1.*?\1/.test(value) ||
    /^\/.+\//.test(value) ||
    /^\d+[,\d]*[acdipqs]?$/.test(value)
  );
}

function stripRedirectTokens(tokens: string[]): string[] {
  const result: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (
      token === ">" ||
      token === ">>" ||
      token === "2>" ||
      token === "2>>" ||
      token === ">|" ||
      token === "<"
    ) {
      i += 1;
      continue;
    }

    if (token === "<<" || token === "<<-" || token === "<<~") {
      i += 1;
      continue;
    }

    if (
      token.startsWith(">>") ||
      token.startsWith(">") ||
      token.startsWith("2>>") ||
      token.startsWith("2>") ||
      token.startsWith("<<") ||
      token.startsWith("<")
    ) {
      continue;
    }

    result.push(token);
  }

  return result;
}

function stripHeredocBodies(cmd: string): string {
  const lines = cmd.split("\n");
  const result: string[] = [];
  let terminator: string | null = null;
  let justClosedHeredoc = false;

  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) {
        terminator = null;
        justClosedHeredoc = true;
      }
      continue;
    }

    const match = line.match(/<<-?\s*(?:['"]([\w]+)['"]|([\w]+))/);
    if (match) {
      terminator = match.at(1) ?? match.at(2) ?? null;
    }

    if (justClosedHeredoc) {
      result.push("; " + line);
      justClosedHeredoc = false;
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

function parseBashActions(cmd: string): FileTrackingAction[] {
  const actions: FileTrackingAction[] = [];

  for (const tokens of splitShellCommands(stripHeredocBodies(cmd))) {
    extractRedirectWriteTargets(tokens, actions);

    const command = stripShellCommandWrappers(stripRedirectTokens(tokens));
    if (command.length === 0) {
      continue;
    }

    if (command[0] === "git" && command[1] === "mv") {
      const operands = extractShellOperands(command.slice(2));
      if (operands.length === 2) {
        pushShellMove(actions, operands[0], operands[1]);
      }
      continue;
    }

    if (command[0] === "git" && command[1] === "rm") {
      for (const operand of extractShellOperands(command.slice(2))) {
        pushShellTouch(actions, operand, "delete");
      }
      continue;
    }

    if (command[0] === "mv") {
      const operands = extractShellOperands(command.slice(1));
      if (operands.length === 2) {
        pushShellMove(actions, operands[0], operands[1]);
      }
      continue;
    }

    if (
      command[0] === "rm" ||
      command[0] === "trash" ||
      command[0] === "trash-put" ||
      command[0] === "unlink"
    ) {
      for (const operand of extractShellOperands(command.slice(1))) {
        pushShellTouch(actions, operand, "delete");
      }
      continue;
    }

    if (command[0] === "sed") {
      if (command.some((t) => /^-[a-z]*i/.test(t))) {
        const hasExplicitExpr = command.some((t) => t === "-e" || t === "-f");
        const operands = extractShellOperands(command.slice(1));
        const fileOperands = hasExplicitExpr ? operands : operands.slice(1);
        for (const operand of fileOperands) {
          if (!looksLikeSedExpression(operand)) {
            pushShellTouch(actions, operand, "edit");
          }
        }
      }
      continue;
    }

    if (command[0] === "cp" || command[0] === "rsync") {
      const operands = extractShellOperands(command.slice(1));
      if (operands.length >= 2) {
        pushShellTouch(actions, operands[operands.length - 1], "write");
      }
      continue;
    }

    if (command[0] === "tee") {
      for (const operand of extractShellOperands(command.slice(1))) {
        pushShellTouch(actions, operand, "write");
      }
      continue;
    }

    if (command[0] === "touch") {
      for (const operand of extractShellOperands(command.slice(1))) {
        pushShellTouch(actions, operand, "write");
      }
      continue;
    }

    if (command[0] === "patch") {
      const operands = extractShellOperands(command.slice(1));
      if (operands.length >= 1) {
        pushShellTouch(actions, operands[0], "edit");
      }
      continue;
    }

    if (command[0] === "curl") {
      for (let i = 1; i < command.length; i++) {
        if ((command[i] === "-o" || command[i] === "--output") && i + 1 < command.length) {
          pushShellTouch(actions, command[i + 1], "write");
          break;
        }
      }
      continue;
    }

    if (command[0] === "wget") {
      for (let i = 1; i < command.length; i++) {
        if ((command[i] === "-O" || command[i] === "--output-document") && i + 1 < command.length) {
          pushShellTouch(actions, command[i + 1], "write");
          break;
        }
      }
      continue;
    }

    if (command[0] === "cat") {
      for (const operand of extractShellOperands(command.slice(1))) {
        pushShellTouch(actions, operand, "read");
      }
      continue;
    }

    if (command[0] === "head" || command[0] === "tail") {
      for (const operand of extractHeadTailReadOperands(command.slice(1))) {
        pushShellTouch(actions, operand, "read");
      }
      continue;
    }
  }

  return actions;
}

function parseRpExecActions(cmd: string): FileTrackingAction[] {
  const normalized = cmd.trim();
  if (!normalized) {
    return [];
  }

  const actions: FileTrackingAction[] = [];

  // Search both per-line (common single-line JSON) and full-string
  // (multi-line JSON objects) to catch all patterns.
  const jsonSearches: Array<
    [string, (args: Record<string, unknown>) => FileTrackingAction | null]
  > = [
    [
      "call read_file",
      (args) =>
        typeof args.path === "string"
          ? {
              kind: "touch" as const,
              path: stripReadSliceSuffix(args.path),
              operation: "read" as const,
            }
          : null,
    ],
    [
      "call apply_edits",
      (args) =>
        typeof args.path === "string"
          ? { kind: "touch" as const, path: args.path, operation: "edit" as const }
          : null,
    ],
    ["call file_actions", (args) => extractFileActionsFromJson(args)],
  ];

  // Per-line: each line independently (covers >99% of real input where
  // JSON objects are single-line).
  for (const line of normalized.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    for (const [prefix, build] of jsonSearches) {
      const args = extractJsonObject(trimmedLine, prefix);
      if (args) {
        const action = build(args);
        if (action) actions.push(action);
      }
    }
  }

  // Full-string fallback: search the entire normalized input for
  // patterns that may span lines (multi-line JSON objects). Only
  // add actions not already captured by the per-line scan.
  for (const [prefix, build] of jsonSearches) {
    const args = extractJsonObjectAnywhere(normalized, prefix);
    if (args) {
      const action = build(args);
      if (action && !actionAlreadyCaptured(actions, action)) {
        actions.push(action);
      }
    }
  }

  // Also scan for CLI-style patterns (on the full string, not per-line).
  if (commandStartsWith(normalized, "apply_edits")) {
    const targetPath = extractCliNamedArg(normalized, "path");
    if (targetPath) {
      actions.push({ kind: "touch", path: targetPath, operation: "edit" });
    }
  }

  if (commandStartsWith(normalized, "file_actions")) {
    const action = extractCliNamedArg(normalized, "action");
    const targetPath = extractCliNamedArg(normalized, "path");
    const newPath = extractCliNamedArg(normalized, "new_path");
    if (action === "create" && targetPath) {
      actions.push({ kind: "touch", path: targetPath, operation: "write" });
    }
    if (action === "delete" && targetPath) {
      actions.push({ kind: "touch", path: targetPath, operation: "delete" });
    }
    if (action === "move" && targetPath && newPath) {
      actions.push({ kind: "move", from: targetPath, to: newPath });
    }
  }

  for (const command of splitShellCommands(normalized)) {
    if (command[0] !== "file") {
      continue;
    }

    if (command[1] === "delete") {
      for (const operand of extractShellOperands(command.slice(2))) {
        actions.push({ kind: "touch", path: operand, operation: "delete" });
      }
      continue;
    }

    if (command[1] === "move") {
      const operands = extractShellOperands(command.slice(2));
      if (operands.length === 2) {
        actions.push({ kind: "move", from: operands[0], to: operands[1] });
      }
    }
  }

  const readPath = extractReadPathFromCliCommand(normalized);
  if (readPath) {
    actions.push({ kind: "touch", path: readPath, operation: "read" });
  }

  return actions;
}

function getTrackedToolActions(name: string, args: Record<string, unknown>): FileTrackingAction[] {
  const pathLikeArg = firstDefinedString(args.path, args.file_path, args.filePath, args.file);

  if ((name === "read" || name === "write" || name === "edit") && pathLikeArg) {
    return [{ kind: "touch", path: pathLikeArg, operation: name }];
  }

  if (name === "rp") {
    const rpCall = typeof args.call === "string" ? args.call : null;
    const rpArgs =
      args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : null;
    if (!rpCall || !rpArgs) {
      return [];
    }

    if (rpCall === "read_file" && typeof rpArgs.path === "string") {
      return [{ kind: "touch", path: rpArgs.path, operation: "read" }];
    }

    if (rpCall === "apply_edits" && typeof rpArgs.path === "string") {
      return [{ kind: "touch", path: rpArgs.path, operation: "edit" }];
    }

    if (rpCall === "file_actions") {
      const action = typeof rpArgs.action === "string" ? rpArgs.action : "";
      if (action === "create" && typeof rpArgs.path === "string") {
        return [{ kind: "touch", path: rpArgs.path, operation: "write" }];
      }
      if (action === "delete" && typeof rpArgs.path === "string") {
        return [{ kind: "touch", path: rpArgs.path, operation: "delete" }];
      }
      if (
        action === "move" &&
        typeof rpArgs.path === "string" &&
        typeof rpArgs.new_path === "string"
      ) {
        return [{ kind: "move", from: rpArgs.path, to: rpArgs.new_path }];
      }
    }
  }

  if (name === "rp_exec") {
    const cmd = typeof args.cmd === "string" ? args.cmd : "";
    return parseRpExecActions(cmd);
  }

  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return parseBashActions(command);
  }

  return [];
}

// ── blackhole addition: result-text path recovery ─────────────────

/**
 * Anchor-based edit tools (pi-hashline-edit-pro `replace`/`insert`) carry no
 * path in their arguments — the file is resolved from the anchor internally.
 * The tool result text is the only place the resolved path appears, in one of
 * these shapes (verified against real sessions):
 *   "Successfully replaced in /abs/path.ts. Added 1 line(s), removed 1 line(s)."
 *   "Successfully replaced 3 block(s) in src/x.ts."
 *   "Successfully wrote 18601 bytes to tests/x.ts"
 *   "No changes made to src/x.ts."  (handled by the no-op filter)
 */
const RESULT_TOUCH_PATTERNS: Array<{ re: RegExp; op: FileTouchOperation }> = [
  {
    re: /\bSuccessfully replaced (?:\d+ block\(s\) )?in (\S+?)(?:\.\s|\.$|\s|$)/,
    op: "edit",
  },
  {
    re: /\bSuccessfully inserted[^\n]*?\bin (\S+?)(?:\.\s|\.$|\s|$)/,
    op: "edit",
  },
  {
    re: /\bSuccessfully wrote (?:\d+ bytes )?to (\S+?)(?:\.\s|\.$|\s|$)/,
    op: "write",
  },
];

/** Mutating-tool name guard so bash/build output can't trigger the fallback. */
const RESULT_FALLBACK_TOOL_RE =
  /(edit|replace|insert|patch|apply|write|save|update|create|remove|delete)/i;

function extractTouchActionsFromResultText(toolName: string, text: string): FileTrackingAction[] {
  if (!RESULT_FALLBACK_TOOL_RE.test(toolName)) {
    return [];
  }

  for (const { re, op } of RESULT_TOUCH_PATTERNS) {
    const match = text.match(re);
    if (match?.[1]) {
      return [{ kind: "touch", path: match[1], operation: op }];
    }
  }

  return [];
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      return typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function getToolCallId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return firstDefinedString(
    (value as { id?: unknown }).id,
    (value as { toolCallId?: unknown }).toolCallId,
    (value as { tool_call_id?: unknown }).tool_call_id,
    (value as { tool_use_id?: unknown }).tool_use_id,
  );
}

/**
 * No-op edit detection — extended with the real-world pi / hashline result
 * shapes ("No changes made to <path>.", "Classification: noop").
 */
const NOOP_EDIT_RE =
  /applied:\s*0|no changes applied|no changes made|nothing to (?:do|change)|classification:\s*noop/i;

/**
 * Collect the files touched (read/written/edited/moved/deleted) across the
 * given session messages. Pure — no filesystem access.
 *
 * `cwd` enables merging of relative and absolute references to the same file.
 */
export function collectFilesTouched(messages: Message[], cwd?: string | null): FilesTouchedEntry[] {
  const toolCalls = new Map<string, FileTrackingAction[]>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") {
        continue;
      }

      const toolCallId = getToolCallId(block);
      const toolName =
        typeof (block as { name?: unknown }).name === "string"
          ? (block as { name: string }).name
          : "";
      const args = (block as { arguments?: unknown }).arguments;
      const argObject =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      if (!toolCallId || !toolName) {
        continue;
      }

      const actions = getTrackedToolActions(toolName, argObject);
      if (actions.length > 0) {
        toolCalls.set(toolCallId, actions);
      }
    }
  }

  const touches: TrackedTouchRecord[] = [];
  const moves: FileMove[] = [];

  for (const msg of messages) {
    // bashExecution is a pi session role not present in pi-ai's Message union —
    // widen the role check so TS doesn't narrow it away.
    const role = (msg as { role?: string }).role;
    if (role === "bashExecution") {
      const bashMsg = msg as unknown as { command?: unknown; timestamp?: unknown };
      const command = typeof bashMsg.command === "string" ? bashMsg.command : "";
      const actions = parseBashActions(command);
      const timestamp = typeof bashMsg.timestamp === "number" ? bashMsg.timestamp : 0;
      for (const action of actions) {
        if (action.kind === "move") {
          moves.push({ from: action.from, to: action.to });
          touches.push({ path: action.to, operation: "move", timestamp });
        } else {
          touches.push({ path: action.path, operation: action.operation, timestamp });
        }
      }
      continue;
    }

    if (role !== "toolResult") {
      continue;
    }
    const toolResultMsg = msg as Extract<Message, { role: "toolResult" }>;
    if (toolResultMsg.isError) {
      continue;
    }

    const toolCallId = getToolCallId(msg);
    if (!toolCallId) {
      continue;
    }

    let actions = toolCalls.get(toolCallId);
    const toolResultText = extractTextFromContent(msg.content);
    const isNoOpEdit = NOOP_EDIT_RE.test(toolResultText);

    if ((!actions || actions.length === 0) && !isNoOpEdit) {
      // Anchor-based edit tools carry no path in args — recover it from the
      // result text.
      actions = extractTouchActionsFromResultText(toolResultMsg.toolName, toolResultText);
    }
    if (!actions || actions.length === 0) {
      continue;
    }

    const timestamp = msg.timestamp ?? 0;
    for (const action of actions) {
      if (action.kind === "move") {
        moves.push({ from: action.from, to: action.to });
        touches.push({
          path: action.to,
          operation: "move",
          timestamp,
        });
        continue;
      }

      if (isNoOpEdit && action.operation === "edit") {
        continue;
      }

      touches.push({
        path: action.path,
        operation: action.operation,
        timestamp,
      });
    }
  }

  const currentRoot = getCurrentRootInfo(cwd);
  const rootMappings = buildRootMappings(
    [...touches.map((touch) => touch.path), ...moves.flatMap((move) => [move.from, move.to])],
    currentRoot,
  );
  const sortedRootKeys = [...rootMappings.keys()].sort((left, right) => right.length - left.length);

  const redirects = new Map<string, string>();
  for (const move of moves) {
    const fromPath = normalizeTrackedPath(move.from, rootMappings, currentRoot, sortedRootKeys);
    const toPath = normalizeTrackedPath(move.to, rootMappings, currentRoot, sortedRootKeys);
    if (fromPath && toPath && fromPath !== toPath) {
      redirects.set(fromPath, toPath);
    }
  }

  const merged = new Map<
    string,
    {
      operations: Set<FileTouchOperation>;
      lastTimestamp: number;
      lastOperation: FileTouchOperation;
    }
  >();
  for (const touch of touches) {
    const normalizedPath = normalizeTrackedPath(
      touch.path,
      rootMappings,
      currentRoot,
      sortedRootKeys,
    );
    const canonicalPath = resolveMoveRedirect(normalizedPath, redirects);
    if (!canonicalPath) {
      continue;
    }

    const existing = merged.get(canonicalPath);
    if (existing) {
      existing.operations.add(touch.operation);
      if (touch.timestamp >= existing.lastTimestamp) {
        existing.lastTimestamp = touch.timestamp;
        existing.lastOperation = touch.operation;
      }
      continue;
    }

    merged.set(canonicalPath, {
      operations: new Set([touch.operation]),
      lastTimestamp: touch.timestamp,
      lastOperation: touch.operation,
    });
  }

  const prepared = [...merged.entries()]
    .map(([canonicalPath, value]) => {
      const resolvedPath = resolveCanonicalPath(canonicalPath, rootMappings, currentRoot);
      return {
        path: resolvedPath,
        operations: value.operations,
        lastOperation: value.lastOperation,
        lastTimestamp: value.lastTimestamp,
      };
    })
    .sort((left, right) => right.lastTimestamp - left.lastTimestamp);

  return prepared;
}
