/**
 * Pure argument parser for /blackhole-export.
 *
 * No pi imports anywhere in this module: it must stay importable by unit
 * tests and static-safe for the lazy-load contract (plan-extract-timeline
 * §7/§10). The parser extracts the raw `out:` string only — `.md`-extension
 * and escape-directory validation stay in the command handler.
 */
export interface BlackholeExportOptions {
  out?: string;
  days?: number;
  mode: "distilled" | "timeline";
}

export type ParseResult =
  | { ok: true; value: BlackholeExportOptions }
  | { ok: false; error: string };

export function parseBlackholeExportArgs(args: string): ParseResult {
  let out: string | undefined;
  let daysRaw: string | undefined;
  let modeRaw: string | undefined;

  for (const token of args.split(/\s+/)) {
    if (token.startsWith("out:")) {
      const raw = token.slice("out:".length);
      // Legacy parity: the previous inline regex (/\bout:(\S+)/) required at
      // least one non-space char after the colon, so a bare "out:" token
      // carries no path and is ignored.
      if (raw.length > 0) {
        out = raw;
      }
    } else if (token.startsWith("days:")) {
      daysRaw = token.slice("days:".length);
    } else if (token.startsWith("mode:")) {
      modeRaw = token.slice("mode:".length);
    }
    // Unrecognized tokens are ignored (stray-text tolerance).
  }

  let days: number | undefined;
  if (daysRaw !== undefined) {
    if (!/^\d+$/.test(daysRaw)) {
      return {
        ok: false,
        error: `Invalid days value "${daysRaw}": expected a positive integer (e.g. days:7).`,
      };
    }
    const parsed = Number(daysRaw);
    if (parsed <= 0) {
      return {
        ok: false,
        error: `Invalid days value "${daysRaw}": expected a positive integer (e.g. days:7).`,
      };
    }
    days = parsed;
  }

  let mode: "distilled" | "timeline" = "distilled";
  if (modeRaw !== undefined) {
    if (modeRaw !== "distilled" && modeRaw !== "timeline") {
      return {
        ok: false,
        error: `Invalid mode "${modeRaw}": expected "distilled" or "timeline".`,
      };
    }
    mode = modeRaw;
  }

  const value: BlackholeExportOptions = { mode };
  if (out !== undefined) {
    value.out = out;
  }
  if (days !== undefined) {
    value.days = days;
  }
  return { ok: true, value };
}
