export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return requestWithTimeout((signal) => fetcher(url, { ...init, signal }), timeoutMs);
}

/** Keep the request's abort signal alive until the JSON body is decoded. */
export function fetchJsonWithDeadline(
  url: string,
  timeoutMs: number,
): Promise<{ response: Response; data: unknown }> {
  return requestWithTimeout(async (signal) => {
    const response = await fetch(url, { signal });
    const data: unknown = await response.json();
    return { response, data };
  }, timeoutMs);
}

async function requestWithTimeout<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResponse = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      request(controller.signal),
      timeoutResponse,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
