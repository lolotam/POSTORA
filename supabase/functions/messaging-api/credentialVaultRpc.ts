/**
 * The one piece of the Vault seam that has a wire format, split out so it can
 * be tested without an Edge Runtime.
 *
 * `public.upsert_connector_credential_secret` is declared
 * `RETURNS TABLE(secret_id uuid, configured_fields text[])`. That makes it
 * set-returning, and PostgREST serialises a set-returning function as a JSON
 * array — `[{...}]` — regardless of how many rows come back. `supabase-js`'s
 * `.rpc()` returns that array verbatim unless the caller asks for the
 * singular-object representation. Reading it as a plain object therefore
 * yields `undefined` for every field, which is how every credential save
 * failed with "Malformed response storing connector credentials".
 *
 * Parsing lives here rather than inline in index.ts because the inline
 * version had no seam a test could reach, which is precisely why the shape
 * mismatch shipped: toolWrites.test.ts stubs `upsertCredentials` wholesale, so
 * the RPC payload was never exercised anywhere.
 */

/** Kept identical to the message the seam raised before, so a search for the
 * reported error still lands on this code. */
const MALFORMED = "Malformed response storing connector credentials";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalises whatever `.rpc("upsert_connector_credential_secret", …)` resolved
 * to into the shape the caller needs, accepting both the array PostgREST
 * actually sends and a bare object (what a future `.single()` or a scalar
 * redeclaration would send). Anything else throws — an unreadable payload must
 * never be read as a successful write, because the row update that follows
 * would then persist a null vault link and strand the secret just created.
 */
export function parseCredentialUpsertResult(
  data: unknown,
): { secretId: string; configuredFields: string[] } {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) throw new Error(MALFORMED);

  const secretId = row.secret_id;
  const configuredFields = row.configured_fields;
  if (typeof secretId !== "string" || secretId.length === 0) throw new Error(MALFORMED);
  if (!Array.isArray(configuredFields)) throw new Error(MALFORMED);
  if (!configuredFields.every((field): field is string => typeof field === "string")) {
    throw new Error(MALFORMED);
  }

  return { secretId, configuredFields };
}
