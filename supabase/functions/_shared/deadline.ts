/** A caller deadline plus a local ceiling cover resolution, transport and body reads. */
export async function withDeadline<T>(timeoutMs: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), Math.max(1, timeoutMs));
  try {
    signal.throwIfAborted();
    return await raceSignal(run(signal), signal);
  } finally { clearTimeout(timer); }
}

export function raceSignal<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { Promise.resolve(work).catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Cancel the stream too, including adapters whose fetch ignores its signal. */
export async function bufferedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
  const bytes = await raceSignal(new Response(body).arrayBuffer(), signal);
  return new Response(bytes.byteLength ? bytes : null, { status: response.status, statusText: response.statusText, headers: response.headers });
}
