// Input validation and ownership pre-checks for the set_tool_accounts
// action of messaging-api. Kept out of index.ts so the refusal table is
// testable without an Edge Runtime, mirroring ai-knowledge-ingest/
// sourceVisibility.ts exactly: the underlying semantics live in the
// set_ai_agent_tool_accounts RPC (migration 20260831130000, §12.2), but
// everything that decides BEFORE the database is touched lives here, so a
// caller gets a clean 400/403/404 instead of a raw database error string.
//
// The pre-checks are for clarity, not authority: the RPC re-verifies tool
// and account ownership inside its own transaction and applies the §12.3
// name-collision refusal. Nothing here may be weaker than the RPC.

export class ToolSharingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ToolSharingError";
    this.status = status;
  }
}

export interface SetToolAccountsInput {
  toolId: string;
  // Duplicates collapsed by parse: the RPC tolerates them (it counts
  // DISTINCT), but a caller that sends the same id twice is telling us
  // something it does not mean -- same rule as sourceVisibility.
  socialAccountIds: string[];
}

export function parseSetToolAccountsInput(
  body: Record<string, unknown> | null | undefined,
): SetToolAccountsInput {
  if (!body || typeof body !== "object") {
    throw new ToolSharingError("A request body is required");
  }
  const toolId = body.tool_id;
  if (typeof toolId !== "string" || !toolId.trim()) {
    throw new ToolSharingError("tool_id is required");
  }
  // An omitted list means "shared with no one": legal, and the only way to
  // untick every box. The owning account never appears as a link row (it
  // resolves through social_account_id), so receiving it in the list is also
  // legal -- the RPC excludes it from the insert.
  const rawIds = body.social_account_ids ?? [];
  if (!Array.isArray(rawIds)) {
    throw new ToolSharingError("social_account_ids must be an array");
  }
  if (!rawIds.every((id) => typeof id === "string" && id.trim())) {
    throw new ToolSharingError("social_account_ids must be an array of account ids");
  }
  return {
    toolId,
    socialAccountIds: [...new Set(rawIds as string[])],
  };
}

// The seam the Supabase client actually crosses here, hand-written in the
// register of sourceVisibility.ts: exactly the surface this module uses.
export interface SharingQuery extends PromiseLike<{ data: Array<Record<string, unknown>> | null; error: unknown }> {
  select(columns: string): SharingQuery;
  eq(column: string, value: unknown): SharingQuery;
  in(column: string, values: unknown[]): SharingQuery;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

export type SharingAdminClient = {
  from(table: string): SharingQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
};

export async function setToolAccounts(
  admin: SharingAdminClient,
  { userId, input }: { userId: string; input: SetToolAccountsInput },
): Promise<void> {
  const { data: tool, error: toolError } = await admin
    .from("ai_agent_tools")
    .select("id")
    .eq("id", input.toolId)
    .eq("user_id", userId)
    .maybeSingle();
  if (toolError) throw toolError;
  if (!tool) throw new ToolSharingError("Connector not found", 404);

  if (input.socialAccountIds.length) {
    const { data: ownedRows, error: ownedError } = await admin
      .from("social_accounts")
      .select("id")
      .eq("user_id", userId)
      .in("id", input.socialAccountIds);
    if (ownedError) throw ownedError;
    const owned = new Set(((ownedRows as Array<{ id: string }> | null) ?? []).map((row) => row.id));
    if (owned.size !== input.socialAccountIds.length) {
      // Which id was foreign is not the caller's business to learn.
      throw new ToolSharingError("One or more accounts do not belong to the caller", 403);
    }
  }

  const { error: rpcError } = await admin.rpc("set_ai_agent_tool_accounts", {
    p_user_id: userId,
    p_tool_id: input.toolId,
    p_social_account_ids: input.socialAccountIds,
  });
  // Wrap rather than rethrow: the raw value is a PostgrestError-shaped plain
  // object, which the entrypoint's catch would render as "[object Object]"
  // in both the client response and the system log. The RPC's own message --
  // including the §12.3 collision refusal naming both tools -- is the thing
  // the user needs to see, so it is surfaced verbatim.
  if (rpcError) {
    throw new Error(
      typeof (rpcError as { message?: unknown })?.message === "string"
        ? (rpcError as { message: string }).message
        : "Failed to update connector sharing",
    );
  }
}
