import { locateKnowledgeFile } from "../_shared/knowledgeSourceFiles.ts";

/**
 * Resolving a knowledge source to a URL its owner can download.
 *
 * Extracted from the request handler for the same reason `sourceVisibility.ts`
 * is: the collaborators are injected, so the ownership and 404 rules can be
 * tested without a live Supabase. This is the only path that mints a credential
 * for a user's private file, and it was previously untestable and untested.
 */

/** The subset of the query builder this module uses. Thenable, so it awaits. */
export interface SourceQuery {
  select(columns: string): SourceQuery;
  eq(column: string, value: unknown): SourceQuery;
  maybeSingle(): Promise<{ data: SourceRow | null; error?: unknown }>;
}

export interface SourceReader {
  from(table: string): SourceQuery;
}

/** The storage surface used to mint the link. */
export interface SignerLike {
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
        options: { download: string },
      ): Promise<{ data: { signedUrl?: string } | null; error?: unknown }>;
    };
  };
}

export interface SourceRow {
  id: string;
  file_path: string | null;
  file_name: string | null;
}

export interface DownloadOwner {
  userId: string;
  email?: string | null;
}

export type DownloadOutcome =
  | { ok: true; url: string; sourceId: string }
  | { ok: false; reason: "not_found" | "sign_failed"; sourceId: string | null };

/** How long a minted link stays valid. Long enough for the navigation, no longer. */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Every failure returns `not_found`, whatever caused it: a malformed id, an id
 * that does not exist, an id belonging to somebody else, and a file_path that
 * resolves nowhere are indistinguishable to the caller. A distinct answer for
 * "exists but not yours" would confirm that an id exists.
 *
 * `sign_failed` is separated only so the caller can log it; it must still be
 * reported to the client as the same 404.
 */
export async function resolveSourceDownload(
  reader: SourceReader,
  signer: SignerLike,
  owner: DownloadOwner,
  sourceId: unknown,
): Promise<DownloadOutcome> {
  if (typeof sourceId !== "string" || !sourceId) {
    return { ok: false, reason: "not_found", sourceId: null };
  }

  // Scoped by user_id on the read itself rather than checked afterwards, so a
  // row belonging to someone else is never in hand to leak through a later bug.
  const { data: source } = await reader
    .from("ai_knowledge_sources")
    .select("id, file_path, file_name")
    .eq("id", sourceId)
    .eq("user_id", owner.userId)
    .maybeSingle();
  if (!source) return { ok: false, reason: "not_found", sourceId };

  const location = locateKnowledgeFile(source.file_path, {
    userId: owner.userId,
    email: owner.email ?? undefined,
  });
  if (!location) return { ok: false, reason: "not_found", sourceId };

  if (location.kind === "cloudinary") {
    // Returned as-is, per the agreed contract. An `fl_attachment` rewrite would
    // name the file, but no stored row reaches this branch today and injecting
    // a transformation breaks delivery outright on an account with strict
    // transformations enabled.
    return { ok: true, url: location.url, sourceId };
  }

  const fileName = source.file_name || source.id;
  const { data: signed, error } = await signer.storage
    .from(location.bucket)
    .createSignedUrl(location.path, DOWNLOAD_URL_TTL_SECONDS, { download: fileName });
  if (error || !signed?.signedUrl) {
    return { ok: false, reason: "sign_failed", sourceId };
  }
  return { ok: true, url: signed.signedUrl, sourceId };
}
