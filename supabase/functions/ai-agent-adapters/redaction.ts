import { redactSensitive } from "../_shared/logging.ts";

const REDACTED = "[REDACTED]";

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

function credentialRepresentations(credentials: Record<string, unknown>): string[] {
  const values = new Set<string>();
  collectStrings(credentials, values);
  for (const value of [...values]) {
    values.add(encodeURIComponent(value));
    values.add(`Bearer ${value}`);
  }

  const key = credentials.consumer_key;
  const secret = credentials.consumer_secret;
  if (typeof key === "string" && typeof secret === "string") {
    try {
      const encoded = btoa(`${key}:${secret}`);
      values.add(encoded);
      values.add(`Basic ${encoded}`);
    } catch {
      // WooCommerce keys are ASCII; exact raw-value redaction still applies.
    }
  }
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

// A deeply nested JSONB column must not recurse without a bound.
const REDACTION_MAX_DEPTH = 10;

function stripCredentialValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > REDACTION_MAX_DEPTH) return REDACTED;
  if (typeof value === "string") {
    // Keep the generic bearer-token rule: a token in a customer row is still a
    // token, even when it is not one of ours.
    if (/^Bearer\s+\S/i.test(value)) return REDACTED;
    return secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripCredentialValue(entry, secrets, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, stripCredentialValue(entry, secrets, depth + 1)]),
    );
  }
  return value;
}

/**
 * Replaces every occurrence of the supplied credentials (raw, URL-encoded and
 * Bearer forms included, via credentialRepresentations) inside an arbitrary
 * JSON value, plus a generic leading Bearer-token rule, bounded by depth.
 *
 * C7: the Supabase page loop calls this BEFORE per-cell truncation, so a
 * credential longer than the cell cap cannot be cut into an unmatchable
 * prefix that then survives trimming.
 */
export function stripCredentialValues(value: unknown, secrets: string[]): unknown {
  return stripCredentialValue(value, secrets);
}

/**
 * The expensive half of the above: builds every form a credential can take.
 * Hoist this above a row loop; it allocates a Set, encodes, base64s and sorts.
 */
export function credentialSecrets(credentials: Record<string, unknown>): string[] {
  return credentialRepresentations(credentials);
}

function isSupabaseReadEnvelope(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true && candidate.vendor === "supabase" &&
    candidate.action === "execute" &&
    candidate.data !== null && typeof candidate.data === "object" &&
    Array.isArray((candidate.data as Record<string, unknown>).rows);
}

export function redactConnectorOutput(
  value: unknown,
  credentials: Record<string, unknown>,
): unknown {
  const secrets = credentialRepresentations(credentials);

  // One payload skips the generic key-name and hex pass: the ROWS of a
  // successful Supabase read. Those are the customer's own columns, on a table
  // the operator allow-listed, and a column called `key`, `token` or `api_key`
  // is ordinary business data -- blanking it made a full-table read useless.
  // Credential-value redaction still runs on them, and everything else --
  // every other vendor, every error, every test-connection result -- keeps the
  // key-name pass exactly as before.
  if (isSupabaseReadEnvelope(value)) {
    const { data, ...envelope } = value;
    const payload = data as Record<string, unknown>;
    const { rows, ...meta } = payload;
    return {
      ...(stripCredentialValue(redactSensitive(envelope), secrets) as Record<string, unknown>),
      data: {
        ...(stripCredentialValue(redactSensitive(meta), secrets) as Record<string, unknown>),
        rows: stripCredentialValue(rows, secrets),
      },
    };
  }

  return stripCredentialValue(redactSensitive(value), secrets);
}

