/**
 * Validation for a URL a user asks Postora to scrape.
 *
 * KNOWN LIMIT, stated rather than implied: this does not defeat DNS rebinding.
 * A public hostname that resolves to a private address still passes here,
 * because the fetch is performed by Firecrawl, not by us — their egress is the
 * boundary that would have to enforce it. What this stops is the direct forms:
 * a scheme that reads a local file, a literal private address, and credentials
 * smuggled into a URL that would then be logged. The same limit is documented
 * for the n8n node's safeFetchAndStage.
 *
 * A rejected URL must never be recorded as a source — the caller returns the
 * reason and creates nothing.
 */

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const MAX_URL_LENGTH = 2048;

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((part) => Number(part));
  if (parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parsed;
  // Boundary cases enumerated: 0.x (this network), 10.x, 127.x (loopback),
  // 169.254.x (link-local, which is where the cloud metadata endpoint lives),
  // 172.16-31.x, 192.168.x. 172.15 and 172.32 are public and must pass.
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  // URL keeps IPv6 literals in brackets and lowercases them.
  const address = hostname.replace(/^\[|\]$/g, "");
  if (address === "::1" || address === "::") return true;
  // fc00::/7 — unique local addresses.
  return /^f[cd][0-9a-f]{2}:/.test(address);
}

function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // A bare label with no dot is a LAN name, never a public site.
  if (!host.includes(".") && !host.startsWith("[")) return true;
  if (host.startsWith("[")) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}

export function validateKnowledgeUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "Enter the address of the page you want to scrape." };
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `That address is longer than ${MAX_URL_LENGTH} characters.` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid web address." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "The address must start with https:// — http and other schemes are not accepted." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Remove the username and password from the address." };
  }
  if (isNonPublicHost(url.hostname)) {
    return { ok: false, reason: "That address is not reachable from the public internet." };
  }

  // The fragment never reaches a server, so keeping it would only make two
  // requests for one page look like two different sources.
  url.hash = "";
  return { ok: true, url: url.toString() };
}
