/**
 * Pi-vcc compaction details type.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/details.ts)
 * Unmodified.
 */
export interface PiVccCompactionDetails {
  compactor: "blackhole";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
}
