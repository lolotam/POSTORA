/**
 * URL contract for messaging-inbox deep links.
 *
 * These param names are a lasting contract: deal cards, emails and external links
 * point at them, so renaming one breaks saved links. Keep them short and stable.
 *
 *   ws      — workspace id
 *   account — social account id
 *   chat    — messaging_cache.id (NOT the external conversation_id string, which
 *             is not stable across reconnects)
 */
export const INBOX_WORKSPACE_PARAM = "ws";
export const INBOX_ACCOUNT_PARAM = "account";
export const INBOX_CHAT_PARAM = "chat";

export interface InboxRouteSelection {
  workspaceId?: string;
  accountId?: string;
  conversationCacheId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/**
 * Parse a selection out of query params. Anything malformed yields `undefined`
 * for that part rather than throwing, so a hand-edited or stale URL degrades to a
 * safe empty selection instead of crashing the inbox.
 */
export function parseInboxRoute(
  params: URLSearchParams | string,
): InboxRouteSelection {
  const searchParams = typeof params === "string" ? new URLSearchParams(params) : params;
  const selection: InboxRouteSelection = {};

  const workspaceId = validId(searchParams.get(INBOX_WORKSPACE_PARAM));
  const accountId = validId(searchParams.get(INBOX_ACCOUNT_PARAM));
  const conversationCacheId = validId(searchParams.get(INBOX_CHAT_PARAM));

  if (workspaceId) selection.workspaceId = workspaceId;
  if (accountId) selection.accountId = accountId;
  if (conversationCacheId) selection.conversationCacheId = conversationCacheId;
  return selection;
}

/** Build query params for a selection, omitting any invalid or missing part. */
export function buildInboxRouteParams(
  selection: InboxRouteSelection,
): URLSearchParams {
  const searchParams = new URLSearchParams();
  const workspaceId = validId(selection.workspaceId);
  const accountId = validId(selection.accountId);
  const conversationCacheId = validId(selection.conversationCacheId);

  if (workspaceId) searchParams.set(INBOX_WORKSPACE_PARAM, workspaceId);
  if (accountId) searchParams.set(INBOX_ACCOUNT_PARAM, accountId);
  if (conversationCacheId) searchParams.set(INBOX_CHAT_PARAM, conversationCacheId);
  return searchParams;
}

/** Build a full inbox path, e.g. for a deal card's "open conversation" link. */
export function buildInboxRoute(
  selection: InboxRouteSelection,
  basePath = "/messaging/whatsapp/conversations",
): string {
  const query = buildInboxRouteParams(selection).toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * Merge a selection into existing params, preserving unrelated ones (filters,
 * tabs) so deep-link syncing never discards the rest of the query string.
 */
export function withInboxRoute(
  existing: URLSearchParams,
  selection: InboxRouteSelection,
): URLSearchParams {
  const merged = new URLSearchParams(existing);
  const next = buildInboxRouteParams(selection);

  [INBOX_WORKSPACE_PARAM, INBOX_ACCOUNT_PARAM, INBOX_CHAT_PARAM].forEach((param) => {
    const value = next.get(param);
    if (value) {
      merged.set(param, value);
    } else {
      merged.delete(param);
    }
  });
  return merged;
}
