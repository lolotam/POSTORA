// The identity and naming of an account's indexed business profile, and the
// input rules for renaming any source. Kept out of index.ts so the decisions
// are testable without an Edge Runtime.
//
// Until 2026-09-13 the profile source was found by its file_name, so the name
// could never change and a second copy appeared whenever the name did. The
// account id now lives in metadata.profile_account_id, which is the lookup
// key; file_name is a label the user may edit.

export const PROFILE_ACCOUNT_KEY = "profile_account_id";
export const MAX_SOURCE_NAME_LENGTH = 120;

export class SourceNameError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SourceNameError";
    this.status = status;
  }
}

/** `Business profile (<platform> · <uuid>)` — the name the old lookup keyed on. */
export const LEGACY_ACCOUNT_PROFILE_TITLE = /^Business profile \(([a-z_]+) · ([0-9a-f-]{36})\)$/i;

export function legacyAccountProfileFileName(platform: string, accountId: string): string {
  return `Business profile (${platform} · ${accountId})`;
}

export function legacyPlatformProfileFileName(platform: string): string {
  return `Business profile (${platform})`;
}

/**
 * The default label for an account's profile file: the account's own name,
 * because a uuid tells the person nothing. An account with no username keeps
 * the id so the row is still identifiable.
 */
export function profileSourceFileName(
  platform: string,
  account: { id: string; platform_username?: string | null; platform_user_id?: string | null },
): string {
  const label = account.platform_username?.trim() || account.platform_user_id?.trim() || account.id;
  return `Business profile · ${label} (${platform})`;
}

export interface RenameSourceInput {
  sourceId: string;
  fileName: string;
}

/** Trimmed, one line, 1..MAX_SOURCE_NAME_LENGTH characters. */
export function parseRenameSourceInput(
  body: Record<string, unknown> | null | undefined,
): RenameSourceInput {
  if (!body || typeof body !== "object") throw new SourceNameError("A request body is required");
  const sourceId = body.source_id;
  if (typeof sourceId !== "string" || !sourceId.trim()) throw new SourceNameError("source_id is required");
  const raw = body.file_name;
  if (typeof raw !== "string") throw new SourceNameError("file_name is required");
  const fileName = raw.replace(/\s+/g, " ").trim();
  if (!fileName) throw new SourceNameError("file_name must not be empty");
  if (fileName.length > MAX_SOURCE_NAME_LENGTH) {
    throw new SourceNameError(`file_name must be at most ${MAX_SOURCE_NAME_LENGTH} characters`);
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(fileName)) throw new SourceNameError("file_name must be a single line of text");
  return { sourceId: sourceId.trim(), fileName };
}

/**
 * Whether the platform-wide profile source can go.
 *
 * It existed for the time before account-scoped configs and is still the only
 * profile some accounts have. It is retired only once EVERY account config on
 * the platform has a profile file of its own; until then deleting it would
 * take knowledge away from an account that still reads it.
 */
export function shouldRetireLegacyPlatformProfile(
  accountIdsOnPlatform: readonly string[],
  accountIdsWithOwnProfile: readonly string[],
): boolean {
  if (accountIdsOnPlatform.length === 0) return false;
  const covered = new Set(accountIdsWithOwnProfile);
  return accountIdsOnPlatform.every((id) => covered.has(id));
}
