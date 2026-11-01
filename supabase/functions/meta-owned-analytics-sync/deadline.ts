export class AnalyticsWorkerStopped extends Error {
  constructor(readonly reason: "deadline" | "storage_unavailable" | "invalid_contract" | "admission_refused" | "configuration_unavailable", readonly sqlstate: string | null = null) {
    super(`Owned analytics operation stopped: ${reason}`);
    this.name = "AnalyticsWorkerStopped";
  }
}

/** Caller deadlines stop waiting; they never prove that a database write rolled back. */
export class AnalyticsWorkerDeadline {
  constructor(readonly startedAt: number, readonly signal: AbortSignal) {}

  get remainingMs(): number { return this.startedAt + 40_000 - Date.now(); }

  async run<T>(work: (signal: AbortSignal) => PromiseLike<T>, reserveMs = 5_000): Promise<T> {
    const remaining = this.remainingMs - reserveMs;
    if (remaining <= 0 || this.signal.aborted) throw new AnalyticsWorkerStopped("deadline");
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(5_000, remaining));
    let rejectAbort: () => void = () => undefined;
    const refused = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new AnalyticsWorkerStopped("deadline"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new AnalyticsWorkerStopped("deadline");
        return work(controller.signal);
      });
      return await Promise.race([pending, refused]);
    }
    finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
}
