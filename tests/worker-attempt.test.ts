import { getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkerAttempt, WorkerAttemptTimeoutError } from "../src/om/worker-attempt.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runWorkerAttempt", () => {
  it("uses the parent signal directly when the timeout is omitted", async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await runWorkerAttempt("observer", undefined, parent.signal, async (signal) => {
      receivedSignal = signal;
      return "done";
    });

    expect(receivedSignal).toBe(parent.signal);
  });

  it("uses the parent signal directly when the timeout is disabled with 0", async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await runWorkerAttempt("observer", 0, parent.signal, async (signal) => {
      receivedSignal = signal;
      return "done";
    });

    expect(receivedSignal).toBe(parent.signal);
  });

  it("returns a result completed before the hard deadline", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();

    const result = await runWorkerAttempt("reflector", 100, parent.signal, async () => "done");

    expect(result).toBe("done");
  });

  it("rejects with a typed stage-specific error at the hard deadline", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const pending = runWorkerAttempt(
      "observer",
      100,
      parent.signal,
      async () => await new Promise<string>(() => {}),
    );
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: "WorkerAttemptTimeoutError",
        stage: "observer",
        timeoutMs: 100,
        message: "observer model attempt timed out after 100 ms",
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  it("aborts the attempt signal at the hard deadline", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const pending = runWorkerAttempt("dropper", 100, parent.signal, async (signal) => {
      receivedSignal = signal;
      return await new Promise<string>(() => {});
    });
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(100);

    if (!receivedSignal) throw new Error("worker did not receive an attempt signal");
    expect(receivedSignal.aborted).toBe(true);
  });

  it("uses WorkerAttemptTimeoutError as the abort reason", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const pending = runWorkerAttempt("dropper", 100, parent.signal, async (signal) => {
      receivedSignal = signal;
      return await new Promise<string>(() => {});
    });
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(100);

    if (!receivedSignal) throw new Error("worker did not receive an attempt signal");
    expect(receivedSignal.reason).toBeInstanceOf(WorkerAttemptTimeoutError);
  });

  it("forwards parent cancellation to the attempt signal", async () => {
    const parent = new AbortController();
    const reason = new Error("session changed");
    let receivedSignal: AbortSignal | undefined;
    const pending = runWorkerAttempt("observer", 1_000, parent.signal, async (signal) => {
      receivedSignal = signal;
      return await new Promise<string>(() => {});
    });
    pending.catch(() => undefined);

    parent.abort(reason);
    await Promise.resolve();

    if (!receivedSignal) throw new Error("worker did not receive an attempt signal");
    expect(receivedSignal.reason).toBe(reason);
  });

  it("rejects with the parent reason when a worker ignores cancellation", async () => {
    const parent = new AbortController();
    const reason = new Error("session changed");
    const pending = runWorkerAttempt(
      "observer",
      1_000,
      parent.signal,
      async () => await new Promise<string>(() => {}),
    );
    let rejection: unknown;
    pending.catch((error) => {
      rejection = error;
    });

    parent.abort(reason);
    await Promise.resolve();

    expect(rejection).toBe(reason);
  });

  it("returns a worker rejection before the deadline unchanged", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const failure = new Error("provider exploded");

    await expect(
      runWorkerAttempt("observer", 100, parent.signal, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("clears the deadline timer once the attempt settles", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();

    await runWorkerAttempt("observer", 100, parent.signal, async () => "done");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the settled attempt's signal alone when the deadline passes", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await runWorkerAttempt("observer", 100, parent.signal, async (signal) => {
      receivedSignal = signal;
      return "done";
    });
    await vi.advanceTimersByTimeAsync(500);

    if (!receivedSignal) throw new Error("worker did not receive an attempt signal");
    expect(receivedSignal.aborted).toBe(false);
  });

  it("removes the parent abort listener once the attempt has settled", async () => {
    const parent = new AbortController();

    await runWorkerAttempt("observer", 1_000, parent.signal, async () => "done");

    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });

  it("leaves the settled attempt's signal un-aborted when the parent aborts afterwards", async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const result = await runWorkerAttempt("observer", 1_000, parent.signal, async (signal) => {
      receivedSignal = signal;
      return "done";
    });

    expect(result).toBe("done");
    parent.abort(new Error("session changed"));
    await Promise.resolve();

    if (!receivedSignal) throw new Error("worker did not receive an attempt signal");
    expect(receivedSignal.aborted).toBe(false);
  });

  it("does not invoke the worker when the parent is already aborted", async () => {
    const parent = new AbortController();
    const reason = new Error("session changed");
    parent.abort(reason);
    const run = vi.fn(async () => "done");

    await expect(runWorkerAttempt("observer", 1_000, parent.signal, run)).rejects.toBe(reason);

    expect(run).not.toHaveBeenCalled();
  });
});
