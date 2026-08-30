// Whether a knowledge source is visible to one connected account.
//
// This MUST stay identical to the predicate in match_ai_knowledge_*_for_account
// (migration 20260828180000) FOR A NAMED ACCOUNT. A list that shows a document
// the agent cannot retrieve, or hides one it can, makes the user confident about
// the wrong thing.
//
// One deliberate divergence: the RPCs gate on
// EXISTS (owned.id = p_social_account_id), so a NULL account retrieves NOTHING.
// Here a null account returns everything, because "no account selected" is the
// management view of the user's own library rather than a retrieval call. Named
// so nobody "fixes" one side to match the other.
//
// The RPCs also check that the caller owns the account and that each link's
// account belongs to the user. Both are redundant HERE and only here: the links
// query runs in the browser under the user's own JWT against a table whose RLS
// is `auth.uid() = user_id`, and accountId comes from useSocialAccounts, which is
// already user-scoped. The RPCs need those checks because Edge Functions call
// them under the service role, where RLS is not evaluated. If this predicate ever
// moves server-side, or `links` is ever fetched with the service key, the
// ownership checks must come back -- otherwise one user's link row would make
// another user's source visible.

export interface VisibilityScopedSource {
  id: string;
  visibility: "shared" | "restricted";
}

export interface SourceAccountLink {
  source_id: string;
  social_account_id: string;
}

export function visibleToAccount(
  source: VisibilityScopedSource,
  accountId: string | null,
  links: SourceAccountLink[],
): boolean {
  if (!accountId) return true;
  if (source.visibility === "shared") return true;
  return links.some(
    (link) => link.source_id === source.id && link.social_account_id === accountId,
  );
}
