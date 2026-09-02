const UNSAFE_WEBHOOK_URL = "webhook_url must be a public HTTPS URL";

function isUnsafeIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second, third] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 &&
      (second === 0 || second === 168 ||
        (second === 31 && third === 196) ||
        (second === 52 && third === 193) ||
        (second === 88 && third === 99) ||
        (second === 175 && third === 48))) ||
    (first === 198 &&
      (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113);
}

function isUnsafeIpv6(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "");
  const [before, after] = address.split("::");
  const left = before ? before.split(":") : [];
  const right = after ? after.split(":") : [];
  if (
    address.split("::").length > 2 ||
    left.concat(right).some((part) => !/^[\da-f]{1,4}$/i.test(part))
  ) {
    return false;
  }

  const missing = 8 - left.length - right.length;
  const groups = address.includes("::")
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return false;

  const values = groups.map((group) => Number.parseInt(group, 16));
  const ipv4Compatible = values.slice(0, 6).every((value) => value === 0);
  const ipv4Mapped = values.slice(0, 6).every((value, index) =>
    value === (index === 5 ? 0xffff : 0)
  );
  const ipv4Translated = values.slice(0, 4).every((value) => value === 0) &&
    values[4] === 0xffff && values[5] === 0;
  if (ipv4Compatible || ipv4Mapped || ipv4Translated) {
    return isUnsafeIpv4(
      `${values[6] >> 8}.${values[6] & 255}.${values[7] >> 8}.${
        values[7] & 255
      }`,
    );
  }
  return values.every((value) => value === 0) ||
    values.slice(0, 7).every((value) => value === 0) && values[7] === 1 ||
    (values[0] & 0xfe00) === 0xfc00 ||
    (values[0] & 0xffc0) === 0xfe80 ||
    (values[0] & 0xff00) === 0xff00 ||
    (values[0] === 0x2001 && values[1] === 0x0db8);
}

function isInternalHostname(hostname: string): boolean {
  if (hostname.replace(/^\[|\]$/g, "").includes(":")) return false;
  return !hostname.includes(".") || hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") || hostname.endsWith(".corp");
}

export function validateWebhookTarget(webhookUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return UNSAFE_WEBHOOK_URL;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    url.protocol !== "https:" || isInternalHostname(hostname) ||
    isUnsafeIpv4(hostname) || isUnsafeIpv6(hostname)
  ) {
    return UNSAFE_WEBHOOK_URL;
  }
  return null;
}

type WebhookFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface PostWebhookOptions {
  /** Per-hop ceiling. */
  timeoutMs?: number;
  /**
   * How many redirect hops to follow. Every hop is revalidated either way --
   * this bounds the total TIME one call can take, since each hop carries its
   * own timeout, not how safe it is.
   */
  maxRedirects?: number;
}

export async function postWebhook(
  webhookUrl: string,
  init: RequestInit,
  fetcher: WebhookFetcher = fetch,
  options: PostWebhookOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 5;
  let target = webhookUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const validationError = validateWebhookTarget(target);
    if (validationError) throw new Error(validationError);

    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("Webhook request timed out", "TimeoutError"),
        ),
      timeoutMs,
    );
    let response: Response;
    try {
      response = await fetcher(target, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, target).toString();
  }
  throw new Error("Webhook redirect limit exceeded");
}
