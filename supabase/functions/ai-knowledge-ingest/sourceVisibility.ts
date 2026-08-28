// Input validation and ownership decisions for the source-visibility actions
// of ai-knowledge-ingest. Kept out of index.ts so the refusal table is
// testable without an Edge Runtime: the underlying visibility semantics live
// in SQL (migration 20260828180000), but everything that decides BEFORE the
// database is touched lives here.

export type SourceVisibility = "shared" | "restricted";

// Carries the HTTP status the Edge Function should answer with. Expected
// business refusals must not surface as opaque 500s.
export class SourceVisibilityError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SourceVisibilityError";
    this.status = status;
  }
}

export interface SetSourceVisibilityInput {
  sourceId: string;
  visibility: SourceVisibility;
  // Duplicates collapsed by parse: the RPC tolerates them, but a caller that
  // sends the same id twice is telling us something it does not mean.
  socialAccountIds: string[];
}

export function parseSetSourceVisibilityInput(
  body: Record<string, unknown> | null | undefined,
): SetSourceVisibilityInput {
  if (!body || typeof body !== "object") {
    throw new SourceVisibilityError("A request body is required");
  }
  const sourceId = body.source_id;
  if (typeof sourceId !== "string" || !sourceId.trim()) {
    throw new SourceVisibilityError("source_id is required");
  }
  const visibility = body.visibility;
  if (visibility !== "shared" && visibility !== "restricted") {
    throw new SourceVisibilityError("visibility must be 'shared' or 'restricted'");
  }
  // An omitted list means "no accounts": legal for both modes. For
  // 'restricted' that hides the source from every account -- the monotonic
  // opposite of the zero-links-means-everything rule this change replaces.
  const rawIds = body.social_account_ids ?? [];
  if (!Array.isArray(rawIds)) {
    throw new SourceVisibilityError("social_account_ids must be an array");
  }
  if (!rawIds.every((id) => typeof id === "string" && id.trim())) {
    throw new SourceVisibilityError("social_account_ids must be an array of account ids");
  }
  return {
    sourceId,
    visibility,
    socialAccountIds: [...new Set(rawIds as string[])],
  };
}

export interface SourceAccountView {
  visibility: SourceVisibility;
  socialAccountIds: string[];
}

// The seam the Supabase client actually crosses here. The Edge Function
// creates its client without a Database generic, so these hand-written
// shapes name exactly what the visibility actions use -- no more, no `any`.
export type QueryOutcome = { data: unknown; error: unknown };

export interface QueryBuilder extends PromiseLike<QueryOutcome> {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
  maybeSingle: () => Promise<QueryOutcome>;
}

type SupabaseLike = {
  from: (table: string) => QueryBuilder;
};

type RpcCapable = SupabaseLike & {
  rpc: (name: string, args: Record<string, unknown>) => Promise<QueryOutcome>;
};

// Returns the source's visibility and the ids explicitly linked to it, or
// null when the source does not exist or belongs to somebody else -- the two
// are deliberately indistinguishable to the caller.
export async function listSourceAccounts(
  admin: SupabaseLike,
  { userId, sourceId }: { userId: string; sourceId: string },
): Promise<SourceAccountView | null> {
  const { data: source, error } = await admin
    .from("ai_knowledge_sources")
    .select("id, visibility")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const sourceRow = source as { visibility?: string } | null;
  if (!sourceRow) return null;
  const { data: links, error: linkError } = await admin
    .from("ai_knowledge_source_accounts")
    .select("social_account_id")
    .eq("source_id", sourceId);
  if (linkError) throw linkError;
  const linkRows = links as Array<{ social_account_id: string }> | null;
  return {
    visibility: sourceRow.visibility === "restricted" ? "restricted" : "shared",
    socialAccountIds: (linkRows || []).map((link) => link.social_account_id),
  };
}

// Fails fast on a source or account the caller does not own, then delegates
// to set_ai_knowledge_source_visibility, which re-verifies both and applies
// visibility + links in one transaction. The pre-checks are for a clean 404 /
// 403 instead of a database error string; the RPC is the authority.
export async function setSourceVisibility(
  admin: RpcCapable,
  {
    userId,
    input,
  }: { userId: string; input: SetSourceVisibilityInput },
): Promise<void> {
  const { data: source, error } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("id", input.sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!source) throw new SourceVisibilityError("Knowledge source not found", 404);

  if (input.socialAccountIds.length) {
    const { data: ownedRows, error: ownedError } = await admin
      .from("social_accounts")
      .select("id")
      .eq("user_id", userId)
      .in("id", input.socialAccountIds);
    if (ownedError) throw ownedError;
    const ownedRowList = ownedRows as Array<{ id: string }> | null;
    const owned = new Set((ownedRowList || []).map((row) => row.id));
    if (owned.size !== input.socialAccountIds.length) {
      // Which id was foreign is not the caller's business to learn.
      throw new SourceVisibilityError("One or more accounts do not belong to the caller", 403);
    }
  }

  const { error: rpcError } = await admin.rpc(
    "set_ai_knowledge_source_visibility",
    {
      p_user_id: userId,
      p_source_id: input.sourceId,
      p_visibility: input.visibility,
      p_social_account_ids: input.socialAccountIds,
    },
  );
  // Wrap rather than rethrow: the raw value is a PostgrestError-shaped plain
  // object, which the entrypoint's message() would render as "[object
  // Object]" in both the client response and the system log.
  if (rpcError) {
    throw new Error(
      typeof (rpcError as { message?: unknown })?.message === "string"
        ? (rpcError as { message: string }).message
        : "Failed to update source visibility",
    );
  }
}
