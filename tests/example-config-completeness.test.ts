/**
 * Guards example-config.json against drift from DEFAULTS.
 *
 * The file advertises itself as `_all_settings_in_one_file`, so every DEFAULTS
 * key must appear in it. The completeness assertion compares the real set
 * difference to an empty array - it cannot pass by accident when a key is
 * missing, because the diff IS the assertion.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/core/unified-config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ExampleConfig = Record<string, unknown>;

function readExampleConfig(): ExampleConfig {
  return JSON.parse(readFileSync(resolve(ROOT, "example-config.json"), "utf8")) as ExampleConfig;
}

function noteLines(): string[] {
  const notes = readExampleConfig()._notes;
  return Array.isArray(notes)
    ? notes.filter((line): line is string => typeof line === "string")
    : [];
}

/**
 * Keys the example file deliberately leaves unset. Each one must stay justified
 * by a `_notes` line, so the omission is a documented decision rather than rot.
 */
const DELIBERATELY_UNSET: ReadonlySet<string> = new Set(["cacheRetention"]);

/**
 * Optional knobs whose DEFAULTS member is `undefined`. The example file
 * materializes them as the "disabled" 0 instead, matching how CONFIG.md
 * presents them, so they are compared against 0 rather than `undefined`.
 */
const ZERO_MEANS_UNSET: ReadonlySet<string> = new Set([
  "providerIdleTimeoutMs",
  "workerAttemptTimeoutMs",
  "compactAfterTokens",
  "compactAfterRatio",
  "compactReserveTokens",
]);

describe("example-config.json completeness", () => {
  it("lists every DEFAULTS key except the deliberately-unset ones", () => {
    const present = new Set(Object.keys(readExampleConfig()).filter((key) => !key.startsWith("_")));
    const missing = Object.keys(DEFAULTS).filter((key) => !present.has(key));
    expect(missing).toEqual([...DELIBERATELY_UNSET]);
  });

  it("carries the DEFAULTS value for every knob it materializes", () => {
    const example = readExampleConfig();
    const drift: string[] = [];
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const inFile = example[key];
      if (inFile === undefined) continue;
      const expected = ZERO_MEANS_UNSET.has(key) ? 0 : value;
      if (!isDeepStrictEqual(inFile, expected)) {
        drift.push(
          `${key}: file has ${JSON.stringify(inFile)}, DEFAULTS has ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it("justifies every deliberately-unset key in _notes", () => {
    for (const key of DELIBERATELY_UNSET) {
      if (key in readExampleConfig()) continue;
      const justified = noteLines().some((line) => line.trim().startsWith(`${key} (`));
      expect(
        justified,
        `${key} is absent from example-config.json but not explained in _notes`,
      ).toBe(true);
    }
  });
});
