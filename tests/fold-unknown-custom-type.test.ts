/**
 * foldLedger aggregates foreign custom entries into one debug line per fold.
 *
 * Other extensions share the session jsonl, so the branch is full of custom
 * entries blackhole doesn't own (e.g. pi-cache-turn). Folding must skip them
 * while emitting a single deduplicated summary line instead of one line per
 * entry.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../src/om/debug-log.js", () => ({
  debugLog: vi.fn(),
}));

import { debugLog } from "../src/om/debug-log.js";
import { foldLedger } from "../src/om/ledger/fold.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/om/ledger/types.js";

afterEach(() => {
  vi.mocked(debugLog).mockClear();
});

function foreignEntry(id: string, customType: string): Entry {
  return { type: "custom", id, customType, data: { anything: true } };
}

describe("foldLedger foreign custom entries", () => {
  it("aggregates third-party custom types into a single debug log line", () => {
    const entries: Entry[] = [
      { type: "message", id: "msg-1" },
      foreignEntry("f1", "pi-cache-turn"),
      foreignEntry("f2", "edit-guard:event"),
      foreignEntry("f3", "pi-cache-turn"),
      foreignEntry("f4", "session-config-context7"),
    ];

    foldLedger(entries);

    const calls = vi.mocked(debugLog).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("fold.unknown_custom_types");
    expect(calls[0]?.[1]).toEqual({
      counts: {
        "pi-cache-turn": 2,
        "edit-guard:event": 1,
        "session-config-context7": 1,
      },
    });
  });

  it("emits nothing when the branch holds only our own OM entries", () => {
    const entries: Entry[] = [
      { type: "message", id: "msg-1" },
      {
        type: "custom",
        id: "om-1",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "something observed",
              timestamp: "2026-09-23T00:00:00.000Z",
              relevance: "medium",
              sourceEntryIds: ["msg-1"],
              tokenCount: 10,
            },
          ],
          coversUpToId: "msg-1",
        },
      },
    ];

    const folded = foldLedger(entries);

    expect(folded.observations.map((o) => o.id)).toEqual(["aaaaaaaaaaaa"]);
    expect(vi.mocked(debugLog).mock.calls).toEqual([]);
  });

  it("emits nothing for custom entries without a customType", () => {
    const entries: Entry[] = [
      { type: "message", id: "msg-1" },
      { type: "custom", id: "f1", data: { anything: true } },
    ];

    foldLedger(entries);

    expect(vi.mocked(debugLog).mock.calls).toEqual([]);
  });
});
