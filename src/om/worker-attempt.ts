/** Hard elapsed deadlines for one background worker/model attempt. */

export type WorkerStage = "observer" | "reflector" | "dropper";

/** A retryable failure that tells consolidation to cool down the model and try its fallback. */
export class WorkerAttemptTimeoutError extends Error {
  readonly stage: WorkerStage;
  readonly timeoutMs: number;

  constructor(stage: WorkerStage, timeoutMs: number) {
    super(`${stage} model attempt timed out after ${timeoutMs} ms`);
    this.name = "WorkerAttemptTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run one worker/model attempt with an optional hard elapsed deadline.
 *
 * Unlike the provider body-idle timeout, this bounds the whole agent loop:
 * response headers, streamed heartbeats, tool turns, and final confirmation.
 * Timing out aborts the child signal and rejects immediately so consolidation
 * can record cooldown and resolve the next fallback model. The underlying
 * promise remains observed in case a provider ignores cancellation.
 */
export function runWorkerAttempt<T>(
  stage: WorkerStage,
  timeoutMs: number | undefined,
  parentSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return run(parentSignal);

  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const forwardParentAbort = () => {
      const reason = parentSignal.reason ?? new Error("Worker attempt aborted by parent signal");
      settle(() => {
        controller.abort(reason);
        reject(reason);
      });
    };

    parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
    if (parentSignal.aborted) {
      forwardParentAbort();
      return;
    }

    timer = setTimeout(() => {
      const error = new WorkerAttemptTimeoutError(stage, timeoutMs);
      // Mark settled before abort dispatches synchronous listeners. A worker
      // resolving from its abort handler must not beat the hard deadline.
      settle(() => {
        controller.abort(error);
        reject(error);
      });
    }, timeoutMs);
    timer.unref?.();

    let attempt: Promise<T>;
    try {
      attempt = run(controller.signal);
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    attempt.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
