/* eslint-disable @typescript-eslint/no-explicit-any */
import { grantedScopes, splitScopeString } from "./youtubeCommentCapability.ts";

async function readMetadata(
  admin: any,
  accountId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("social_accounts")
    .select("account_metadata")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(`granted_scopes read failed: ${error.message}`);
  const metadata = data?.account_metadata;
  return metadata && typeof metadata === "object"
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

async function writeScopes(
  admin: any,
  accountId: string,
  scopes: string[],
): Promise<void> {
  const metadata = await readMetadata(admin, accountId);
  const { error } = await admin.from("social_accounts")
    .update({
      account_metadata: { ...metadata, granted_scopes: scopes },
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId);
  if (error) throw new Error(`granted_scopes write failed: ${error.message}`);
}

/** Google returns `scope` on token responses; this is the only place it is kept. */
export async function recordGrantedScopes(
  admin: any,
  accountId: string,
  scope: unknown,
): Promise<void> {
  const scopes = splitScopeString(scope);
  if (scopes.length === 0) return;
  await writeScopes(admin, accountId, scopes);
}

/** Self-heal after a 403 insufficientPermissions: the row flips to reconnect_required. */
export async function dropGrantedScope(
  admin: any,
  accountId: string,
  scope: string,
): Promise<void> {
  const metadata = await readMetadata(admin, accountId);
  await writeScopes(
    admin,
    accountId,
    grantedScopes(metadata).filter((granted) => granted !== scope),
  );
}
