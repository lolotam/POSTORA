// Guards for values that arrive from outside and are about to be handed to Postgres.
// Both live here rather than inline in index.ts because a bad value in either one
// fails at the database, not at the call site, which is how the `api_logs` writer
// stayed broken in production without a single error surfacing.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a UUID (v1–v5). Callers use this to return 400 instead of
 *  letting Postgres raise `22P02` on a `uuid` column, which surfaces as a 500. */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Covers the compressed (`::`), full, and IPv4-mapped (`::ffff:1.2.3.4`) forms that
// Postgres `inet` accepts. Deliberately not exhaustive on exotic notations: anything
// this does not recognise is dropped rather than risking a rejected insert.
const IPV6_RE =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/i;

/**
 * Normalises one hop of a forwarding header into something `inet` accepts, or null.
 * Strips the `[...]` brackets and `%zone` suffix proxies add, and the `:port` some
 * append to IPv4 addresses.
 */
function normalizeIp(candidate: string): string | null {
  let value = candidate.trim();
  if (!value) return null;

  // `[2001:db8::1]:443` → `2001:db8::1`
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];

  // `fe80::1%eth0` → `fe80::1`; the zone index is not part of an inet value.
  const zoneAt = value.indexOf("%");
  if (zoneAt !== -1) value = value.slice(0, zoneAt);

  if (IPV4_RE.test(value) || IPV6_RE.test(value)) return value;

  // `1.2.3.4:5678` → `1.2.3.4`. Only ever an IPv4 form: a bare IPv6 address has
  // colons of its own and must be bracketed to carry a port.
  const withPort = value.match(/^([^:]+):\d+$/);
  if (withPort && IPV4_RE.test(withPort[1])) return withPort[1];

  return null;
}

/**
 * The caller's IP, or null when no header carries a usable one.
 *
 * Prefers `cf-connecting-ip` because Cloudflare sets it to the single real client
 * address. `x-forwarded-for` is a comma-separated chain once a request has crossed
 * Cloudflare and Kong, so only its first hop is read — writing the whole chain is
 * what made every `api_logs` insert fail with `22P02` and silently disabled rate
 * limiting for this function.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const direct = headers.get("cf-connecting-ip");
  if (direct) {
    const normalized = normalizeIp(direct);
    if (normalized) return normalized;
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    for (const hop of forwarded.split(",")) {
      const normalized = normalizeIp(hop);
      if (normalized) return normalized;
    }
  }

  return null;
}
