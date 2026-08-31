import type { AdapterDependencies } from "./types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchOneHop(
  url: URL,
  init: RequestInit,
  dependencies: AdapterDependencies,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Connector request timed out"));
    }, dependencies.timeoutMs);
  });

  try {
    return await Promise.race([
      dependencies.fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      }),
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Validates the initial URL and every redirect target. Read calls use zero
 * retries: a bounded no-retry policy avoids doubling load and keeps failures
 * visible to the model. Cross-origin redirects are refused so credentials are
 * never forwarded to a different public host.
 */
export async function safeVendorFetch(
  rawUrl: string,
  init: RequestInit,
  dependencies: AdapterDependencies,
): Promise<Response> {
  let url = await dependencies.assertPublicHttpsUrl(rawUrl);
  const credentialOrigin = url.origin;

  for (let redirectCount = 0; redirectCount <= dependencies.maxRedirects; redirectCount += 1) {
    const response = await fetchOneHop(url, init, dependencies);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (!location) throw new Error("Connector redirect omitted its destination");
    if (redirectCount === dependencies.maxRedirects) {
      throw new Error("Connector returned too many redirects");
    }

    const candidate = new URL(location, url);
    url = await dependencies.assertPublicHttpsUrl(candidate.toString());
    if (url.origin !== credentialOrigin) {
      throw new Error("Connector redirected to a different origin");
    }
  }

  throw new Error("Connector returned too many redirects");
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Connector returned an invalid JSON response");
  }
}

