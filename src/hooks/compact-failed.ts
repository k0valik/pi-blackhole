/**
 * Compact-failed hook — unified handling of the pi `session_compact_failed`
 * event (available from pi 0.84.3).
 *
 * Before this hook existed, failure coverage was fragmented:
 * - Manual `/blackhole` and the auto-trigger had their own `onError` callbacks.
 * - Overflow compaction failures (pi-initiated, mid-turn) were invisible.
 * - `/compact` cancelled by our `session_before_compact` guard was only
 *   notified inside the hook, with no structured log or state cleanup.
 *
 * This hook closes those gaps: structured trace logging, a defensive
 * `compactInFlight` reset, overflow-retry visibility, and pi-default noise
 * filtering. It also corrects attribution — pi reports `fromExtension: false`
 * when a hook cancels with `{ cancel: true }` (it only flags content-bearing
 * compactions), so we derive `attributedFromExtension` from our own flags.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.js";
import { debugLog } from "../om/debug-log.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isStaleExtensionContextError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("extension ctx is stale") ||
    message.includes("ctx is stale")
  );
}

function notifySafely(
  hasUI: boolean,
  ui: any,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (!hasUI) return;
  try {
    ui?.notify(message, level);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

export function registerCompactFailedHook(
  pi: ExtensionAPI,
  runtime: Runtime,
): void {
  // `session_compact_failed` ships in pi >= 0.84.3; our dev-time types pin an
  // older version, so register through a widened signature. On older pi the
  // event never fires and this handler stays dormant.
  const onAny = pi.on as unknown as (
    event: string,
    handler: (event: any, ctx: any) => void,
  ) => void;
  onAny("session_compact_failed", (event, ctx) => {
    try {
      handleCompactFailed(event, ctx, runtime);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }
  });
}

function handleCompactFailed(event: any, ctx: any, runtime: Runtime): void {
  runtime.ensureConfig((ctx?.cwd as string | undefined) ?? process.cwd());

  // This handler runs outside ALS context — pass the config flag explicitly.
  const trace = (ev: string, d?: Record<string, unknown>) =>
    debugLog(ev, d, runtime.config.debugLog === true);

  // Capture ctx properties synchronously — defensive, matches compaction-trigger:
  // the ctx may go stale after session replacement/reload before any deferred use.
  const hasUI = ctx?.hasUI === true;
  const ui = ctx?.ui;
  let sessionId: string | undefined;
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }

  const reason = event?.reason as
    "manual" | "threshold" | "overflow" | undefined;
  const errorMessage = event?.errorMessage as string | undefined;
  const aborted = event?.aborted === true;
  const willRetry = event?.willRetry === true;
  const fromExtension = event?.fromExtension === true;

  // Attribution fix (upstream quirk): pi only sets fromExtension when the
  // failing compaction carried extension content, so `{ cancel: true }` returns
  // from our session_before_compact hook are mislabeled `fromExtension: false`.
  // Capture and consume our attempt-scoped flags before notifications or other
  // side effects can throw; the next before-compact event establishes new state.
  const compactWasPiVcc = runtime.compactWasPiVcc === true;
  const lastCompactCancelled = runtime.lastCompactCancelled === true;
  const attributedFromExtension =
    fromExtension || compactWasPiVcc || lastCompactCancelled;
  runtime.compactWasPiVcc = false;
  runtime.lastCompactCancelled = false;

  trace("compact_failed.received", {
    reason,
    aborted,
    willRetry,
    fromExtension,
    compactWasPiVcc,
    lastCompactCancelled,
    attributedFromExtension,
    errorMessage,
    sessionId,
  });

  // Defensive compactInFlight guard: pi may abort an in-flight compact through
  // a path that never reaches our onError callbacks (overflow pre-emption,
  // session replacement). Abort a pending idle-wait controller before dropping
  // its runtime reference; otherwise its captured signal stays live and can
  // launch a second compaction after a later agent_start/agent_end cycle.
  const pendingController = runtime.autoCompactionController;
  if (
    (aborted || errorMessage) &&
    (runtime.compactInFlight || pendingController)
  ) {
    pendingController?.abort();
    runtime.compactInFlight = false;
    if (runtime.autoCompactionController === pendingController) {
      runtime.autoCompactionController = null;
    }
    trace("compact_failed.compactInFlight_reset", {
      reason,
      abortedPendingWait: pendingController !== null,
    });
  }

  // Overflow-retry visibility: pi aborts the turn's compaction and retries the
  // turn after compaction — previously this was completely invisible.
  if (reason === "overflow" && aborted && willRetry) {
    notifySafely(
      hasUI,
      ui,
      "blackhole: overflow compaction aborted, retrying turn",
      "info",
    );
  }

  // Noise filter: with compactionEngine "pi-default" the failure belongs to
  // pi's engine (unless the content or the trigger was ours) — light trace only.
  if (
    runtime.config.compactionEngine === "pi-default" &&
    !attributedFromExtension
  ) {
    trace("compact_failed.skipped_pi_default", { reason });
    return;
  }

  // Non-abort failures attributed to us: surface the error to the user.
  // Gated on attribution — a pi-default/threshold failure we didn't produce
  // (no extension content, no /blackhole trigger, no hook cancel) isn't ours.
  if (!aborted && errorMessage && attributedFromExtension) {
    notifySafely(
      hasUI,
      ui,
      `blackhole: compaction failed — ${errorMessage}`,
      "error",
    );
  }
}
