/**
 * Incremental session-JSONL line scanner.
 *
 * Adapted from upstream pi-vcc PR #26
 * (https://github.com/sting8k/pi-vcc/pull/26 —
 * "Fix recall for sessions larger than V8's string limit"):
 * `readFileSync(sessionFile, "utf-8")` fails before parsing when a session
 * exceeds V8's maximum string length
 * ("Cannot create a string longer than 0x1fffffe8 characters"), which made
 * recall unusable on long-running sessions. This reads the file in 64 KiB
 * chunks and reassembles lines across chunk boundaries instead.
 *
 * Behavioral contract (shared by recall and the global index map):
 * - A not-yet-written file (fresh session, pi persists on first entry) reads
 *   as missing, not a failure. Every other I/O error still propagates.
 * - Blank lines are skipped; non-blank unparsable lines are counted and
 *   skipped (callers warn, mirroring previous behavior).
 * - A final line without a trailing newline is preserved.
 */
import { closeSync, openSync, readSync } from "fs";

export interface SessionScanResult {
  /** True when the file does not exist yet — caller decides the empty value. */
  missing: boolean;
  /** Non-blank lines that failed JSON parsing (skipped). */
  parseErrors: number;
}

const CHUNK_SIZE = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Invoke `onEntry` for each parsed JSON value in a session JSONL file,
 * in file order, without materializing the whole file as one string.
 */
export const scanSessionEntries = (
  sessionFile: string,
  onEntry: (entry: any) => void,
): SessionScanResult => {
  const state = { parseErrors: 0 };
  const processLine = (line: Buffer): void => {
    if (line.length === 0) return;
    const text = line.toString("utf8");
    if (!text.trim()) return;
    try {
      onEntry(JSON.parse(text));
    } catch {
      state.parseErrors++;
    }
  };

  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch (err) {
    // Pi does not create a new session's JSONL until its first persisted entry.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { missing: true, parseErrors: 0 };
    }
    throw err;
  }

  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  let pending: Buffer[] = [];
  let pendingLength = 0;

  const flushLine = (segment: Buffer): void => {
    if (pendingLength > 0) {
      pending.push(segment);
      processLine(Buffer.concat(pending, pendingLength + segment.length));
      pending = [];
      pendingLength = 0;
    } else {
      processLine(segment);
    }
  };

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] !== NEWLINE) continue;
        flushLine(chunk.subarray(start, i));
        start = i + 1;
      }
      if (start < bytesRead) {
        const remainder = Buffer.from(chunk.subarray(start, bytesRead));
        pending.push(remainder);
        pendingLength += remainder.length;
      }
    }
    // JSONL files normally end with a newline, but preserve a final partial line.
    if (pendingLength > 0) processLine(Buffer.concat(pending, pendingLength));
  } finally {
    closeSync(fd);
  }
  return { missing: false, parseErrors: state.parseErrors };
};
