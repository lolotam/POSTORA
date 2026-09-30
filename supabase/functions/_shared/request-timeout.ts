export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResponse = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      timeoutResponse,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
