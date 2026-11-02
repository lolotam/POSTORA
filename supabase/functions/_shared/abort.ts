/** Race dependencies that ignore AbortSignal; callers also pass it to native I/O. */
export async function awaitWithAbort<T>(work: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException("Operation aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
      return work();
    });
    return await Promise.race([pending, cancelled]);
  } finally { signal.removeEventListener("abort", abort); }
}
