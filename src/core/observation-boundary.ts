import { isObservationsRecordedEntry, type Entry } from "../om/ledger/types.js";
import { isSourceEntry } from "../om/ledger/progress.js";

/** Completed ledger batches only. Never infer observation progress from a cut.
 * A batch must connect to the known prefix through its source anchors. Legacy
 * gaps or malformed anchors keep extra raw context rather than claiming it.
 */
export function observedPrefixIndex(entries: Entry[]): number {
  const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
  const sources = entries.flatMap((entry, index) => (isSourceEntry(entry) ? [index] : []));
  let boundary = -1;
  for (const [markerIndex, entry] of entries.entries()) {
    if (!isObservationsRecordedEntry(entry)) continue;
    const end = indexes.get(entry.data.coversUpToId);
    if (end === undefined || end <= boundary || end >= markerIndex || !isSourceEntry(entries[end]))
      continue;
    const anchors = entry.data.observations.flatMap((observation) =>
      observation.sourceEntryIds.map((id) => indexes.get(id)),
    );
    if (
      anchors.some((index) => index === undefined || index > end || !isSourceEntry(entries[index]))
    )
      continue;
    const next = sources.find((index) => index > boundary);
    if (next === undefined || !anchors.includes(next)) continue;
    boundary = end;
  }
  return boundary;
}
