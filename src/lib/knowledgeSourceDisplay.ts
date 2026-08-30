// A knowledge source's title as a human should read it.
//
// `ai_knowledge_sources.file_name` carries the full account UUID because it is
// the LOOKUP KEY in ai-knowledge-ingest: two accounts resolving one
// "Business profile (instagram)" row meant the second replaced the first's
// chunks, and one brand then answered customers out of another's description.
// The identity keeps the id; only the display resolves it to a name.
//
// Rendering rather than storing also survives a rename -- a stored title would
// become a lie the moment the account's username changed.

interface NamedAccount {
  id: string;
  platform_username?: string | null;
  platform_user_id?: string | null;
}

/** `Business profile (<platform> · <uuid>)` — the shape ai-knowledge-ingest writes. */
const PROFILE_TITLE = /^(Business profile \([^)]*? · )([0-9a-f-]{36})(\))$/i;

export function displaySourceTitle(fileName: string, accounts: NamedAccount[]): string {
  const match = PROFILE_TITLE.exec(fileName);
  if (!match) return fileName;
  const [, prefix, accountId, suffix] = match;
  const account = accounts.find((candidate) => candidate.id === accountId);
  const label = account?.platform_username || account?.platform_user_id;
  // An unknown account keeps its id: harder to read, but it still identifies the
  // row, and a source with no label at all is worse than an ugly one.
  return label ? `${prefix}${label}${suffix}` : fileName;
}
