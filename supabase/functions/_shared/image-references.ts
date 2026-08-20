/**
 * Parsing and validation for the reference images attached to an image
 * generation.
 *
 * This lives apart from `generate-image/index.ts` so it can be unit tested —
 * that file calls `serve()` and imports remote modules at load time, so it
 * cannot run under the app's test runner.
 */

export interface ReferenceInput {
  url: string;
  type: string;
  priority: number;
}

/**
 * Collapse the two reference fields the dialogs send into one list.
 *
 * `referenceImages` carries the per-image type and order; `referenceImage` is
 * the older single-image field, consulted only when the array is absent because
 * the dialog sets it to a copy of the array's first entry.
 */
export function collectReferences(
  single: string | undefined,
  many: { url: string; type?: string; priority?: number }[] | undefined,
): ReferenceInput[] {
  const source = many?.length ? many : single ? [{ url: single }] : [];
  return source.map((ref, index) => ({
    url: ref.url,
    type: ref.type || "style",
    priority: ref.priority ?? index + 1,
  }));
}

/** Split a base64 data URL into its parts, or null when it is not one. */
export function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

/**
 * Reduce a URL hostname to the form the checks below expect.
 *
 * A trailing dot is the absolute-FQDN spelling and resolves identically, so
 * `localhost.` has to be folded onto `localhost` or it walks straight past a
 * check written for the latter. IPv6 hostnames arrive bracketed.
 */
function normalizeHostname(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True for IPv4 literals that are not routable on the public internet. */
function isPrivateIPv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const numbers = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (numbers.some((n) => !Number.isInteger(n) || n > 255)) return false;

  const [a, b] = numbers;
  return (
    a === 0 ||                            // this network
    a === 10 ||                           // private
    a === 127 ||                          // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||           // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||  // private
    (a === 192 && b === 168) ||           // private
    a >= 224                              // multicast and reserved
  );
}

/** True for IPv6 literals that are not routable on the public internet. */
function isPrivateIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;   // unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;   // link-local fe80::/10
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]);

  // The URL parser rewrites ::ffff:169.254.169.254 into its hex form, so the
  // dotted spelling above never survives to be matched.
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return false;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

/**
 * True when a reference URL is safe to fetch server-side.
 *
 * Reference URLs arrive in the request body, so an unchecked fetch would let a
 * caller aim this at the internal network — cloud metadata at 169.254.169.254
 * most of all — and read the response back through the model.
 *
 * Known limit: this validates the hostname, not the address it resolves to, so
 * a public name pointing at a private address still passes. Closing that needs
 * resolve-then-connect control the runtime does not expose.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;

  const host = normalizeHostname(parsed.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  return !isPrivateIPv4(host) && !isPrivateIPv6(host);
}
