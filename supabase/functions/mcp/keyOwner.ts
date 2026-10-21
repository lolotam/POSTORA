// Resolve the owner of a Postora API key.
//
// The MCP edge used to accept any string that started with "postora-" and
// build a server out of it. Nothing checked the key against the database, so
// an unauthenticated caller could reach the refusal paths (a schema
// rejection, a missing confirm, blank recipients) and have the edge write a
// system_logs row for them: unbounded unauthenticated writes into a
// service-role table.
//
// The owner is therefore resolved here, before any tool runs. A key that
// belongs to no profile is not a valid key, and the request is refused with
// 401 before a server is built, so no refusal can ever be recorded for a
// caller nobody authenticated.
//
// A lookup that fails is not a refusal either: it is an outage, and it is
// answered with 503. A database problem must never turn into "your key is
// invalid", and it must never turn into a log row without an owner either.
//
// The database client and the hashing function are injected, so the resolver
// owns no client of its own and can be exercised without a database or a
// network.

export interface KeyOwnerDeps {
  admin: any;
  sha256Hex: (text: string) => Promise<string>;
}

export type KeyOwner =
  | { kind: "owner"; userId: string }
  | { kind: "unknown" }
  | { kind: "error" };

/**
 * Resolve the owner of an API key.
 *
 * - the key belongs to a profile -> `{ kind: "owner", userId }`;
 * - the key belongs to no profile -> `{ kind: "unknown" }`: the caller is not
 *   authenticated, and the request is refused with 401;
 * - the lookup failed or threw -> `{ kind: "error" }`: the request is refused
 *   with 503, because the edge cannot tell whether the caller is allowed in.
 *
 * The key is hashed exactly like n8n-api hashes it before looking the owner
 * up: sha256Hex(apiKey) against profiles.api_key_hash. The key itself and
 * its hash never reach the log: a failure is reported on the edge in one
 * line, without either of them.
 */
export async function resolveKeyOwner(
  deps: KeyOwnerDeps,
  apiKey: string,
): Promise<KeyOwner> {
  try {
    const apiKeyHash = await deps.sha256Hex(apiKey);

    const { data: row, error } = await deps.admin
      .from("profiles")
      .select("id")
      .eq("api_key_hash", apiKeyHash)
      .maybeSingle();

    if (error) {
      console.error("[mcp] key owner lookup failed");
      return { kind: "error" };
    }

    if (!row || typeof row.id !== "string" || row.id.length === 0) {
      return { kind: "unknown" };
    }

    return { kind: "owner", userId: row.id };
  } catch {
    console.error("[mcp] key owner lookup failed");
    return { kind: "error" };
  }
}
