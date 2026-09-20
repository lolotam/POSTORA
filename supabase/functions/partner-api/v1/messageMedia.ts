// GET /v1/messages/{id}/media — the bytes behind an inbound message.
//
// WHY THIS IS NOT `GET /v1/media/{id}/download`
// ---------------------------------------------
// media.ts:10-14 defers that route deliberately, and this does not contradict
// it. That one is a sub-resource of `media_files` — partner UPLOADS, in the
// `partner-media` bucket, whose bytes the partner already holds because they
// sent them. This is a sub-resource of a MESSAGE: inbound media, in the `media`
// bucket, with no `media_files` row anywhere (the resolver only ever writes the
// storage path back onto whatsapp_messages.media_url). Different table,
// different bucket, different tenancy predicate, so a different route.
//
// The id is `msg_…`, not a new `media_…`. ids.ts:5-10 exists so a client passing
// the wrong kind of id fails at the door rather than matching some other table's
// row that happens to share a uuid; minting a second `media_` over a different
// table would destroy exactly that property.
//
// WHY JSON AND NOT BYTES OR A REDIRECT
// ------------------------------------
// Streaming the object back through this function would pull it into the
// isolate and re-incur the byte budget the resolver exists to manage. A 302
// would put a live capability URL into a Location header and therefore into
// every proxy log on the path, which is the exposure partnerMediaStore.ts:258-266
// objects to, merely relocated. JSON keeps it in a body the partner controls and
// lets the expiry be stated next to it.
import { boundAccountIds } from "./binding.ts";
import { decodeId } from "./ids.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { isHttpMediaUrl, ownedStoragePath, resolveWhatsAppMedia } from "../../_shared/whatsappMediaResolver.ts";
import type { WhatsAppAccountAccess } from "../../_shared/whatsappWorkspaceAccess.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/**
 * Partner-facing lifetime of the minted URL.
 *
 * Deliberately shorter than the resolver's 3600s inbound default: that default
 * was chosen for a browser session behind a user JWT, where the holder is the
 * authenticated user already. This URL is held by a third party in third-party
 * infrastructure and should not outlive the request that minted it by an hour.
 *
 * The number is emitted in the response and documented, because "temporary"
 * without a number is not a contract and produces integrations that cache the
 * URL and then break silently when it dies.
 */
export const PARTNER_MEDIA_URL_TTL_SECONDS = 900;

export async function getMessageMedia(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const messageId = decodeId("msg", params.id ?? "");
  if (messageId === null) return v1ErrorResponse("resource_not_found", requestId);

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  if (bound.ids.length === 0) return v1ErrorResponse("resource_not_found", requestId);

  // The binding is part of the LOOKUP, never a check applied to a row already
  // read: a row fetched first and rejected second is one refactor away from
  // being returned by mistake. Identical to getMessage in conversations.ts.
  const { data: message, error } = await admin
    .from("whatsapp_messages")
    .select("id, social_account_id, media_type, media_url, direction")
    .eq("id", messageId)
    .in("social_account_id", bound.ids)
    // Inbound only. The route and the published contract describe a sub-resource
    // of an INBOUND message; without this an owner-sent echo or an outbound
    // history row carrying media would be published through a surface that
    // promises the other direction.
    .eq("direction", "inbound")
    .maybeSingle();

  if (error) {
    console.error(`[partner-api] v1 message media lookup failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  // Both misses answer the same way, so a partner cannot tell "not yours" from
  // "does not exist". resource_forbidden would confirm the row exists.
  if (!message) return v1ErrorResponse("resource_not_found", requestId);
  // A text message is a real message with no media sub-resource.
  if (!message.media_type) return v1ErrorResponse("resource_not_found", requestId);

  // resolveWhatsAppMedia authorises NOTHING of its own — its only tenancy
  // control is `.eq("social_account_id", access.accountId)`. `access` is a
  // proof-carrying token, so it is built only after the binding above has
  // already proven this key may read this row.
  //
  // Deliberately NOT resolveWhatsAppAccount(): with no explicit account it
  // falls back to partner_api_keys.social_account_id, the primary-account
  // column binding.ts says reads must never anchor on, and it refuses an
  // inactive or reauth-flagged account — which would deny a download of bytes
  // already cached in storage. A dead token degrades to an unavailable item
  // inside the resolver on its own; that is the right answer to reach.
  const { data: account, error: accountError } = await admin
    .from("social_accounts")
    .select(
      "id, user_id, workspace_id, platform, platform_user_id, platform_username, " +
        "access_token, connection_mode, account_metadata",
    )
    .eq("id", message.social_account_id)
    // Tenancy proven twice, per binding.ts: the composite FKs already make a
    // cross-workspace binding unrepresentable, and this keeps a hand-written
    // row or a restored backup from turning a data defect into a cross-tenant read.
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();

  if (accountError) {
    console.error(`[partner-api] v1 message media account load failed (request ${requestId}):`, accountError);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!account || account.platform !== "whatsapp") {
    return v1ErrorResponse("resource_not_found", requestId);
  }

  const access: WhatsAppAccountAccess = {
    accountId: account.id,
    // MUST be social_accounts.user_id and not the workspace owner: it is the
    // first segment of the derived cache path, so a different value writes a
    // second copy at a path nothing else can find.
    ownerId: account.user_id,
    workspaceId: account.workspace_id,
    // Unread by the resolver. The partner tier has no workspace_members row and
    // must not fabricate a privileged one; the least-privileged value is correct.
    role: "viewer",
    platformUserId: account.platform_user_id,
    platformUsername: account.platform_username,
    accessToken: account.access_token || "",
    connectionMode: account.connection_mode,
    accountMetadata: account.account_metadata,
  };

  // The account binding proved who owns the message ROW. It says nothing about
  // who owns the storage OBJECT the row points at, and those are separate facts:
  // the resolver hands any non-http media_url straight to the signer without
  // consulting its own ownedStoragePath validator. A path left by a bad restore
  // or a malformed writer would otherwise be signed with the service-role client
  // and handed to a partner. Refuse instead of minting a URL over it.
  if (message.media_url && !isHttpMediaUrl(message.media_url)) {
    try {
      ownedStoragePath(message.media_url, account.user_id);
    } catch {
      console.error(
        `[partner-api] v1 media path is not owned by the account that holds the message (request ${requestId})`,
      );
      return v1ErrorResponse("resource_not_found", requestId);
    }
  }

  const [item] = await resolveWhatsAppMedia(
    admin,
    access,
    { messageRowIds: [message.id] },
    { signTtlSeconds: PARTNER_MEDIA_URL_TTL_SECONDS },
  );

  if (!item || item.url === null) {
    // too_large is a permanent fact about these bytes and a retry cannot change
    // it. Everything else — deadline, byte budget, no fetcher, a failed fetch or
    // a failed signature — is transient, which is why it answers media_unavailable
    // and not temporarily_unavailable: the latter is a deliberate suspension whose
    // policy says retrying will not succeed, and would tell a caller to abandon a
    // download that the next attempt would have served.
    return item?.reason === "too_large"
      ? v1ErrorResponse("payload_too_large", requestId, {
        message: "The media exceeds the size this API will materialise",
      })
      : v1ErrorResponse("media_unavailable", requestId);
  }

  const expiresIn = item.expires_in ?? PARTNER_MEDIA_URL_TTL_SECONDS;
  return v1JsonResponse({
    message_id: params.id,
    type: item.kind,
    mime_type: item.mime_type ?? null,
    file_name: item.file_name ?? null,
    size_bytes: item.size_bytes ?? null,
    url: item.url,
    // Emitted from the item rather than the constant, so the number published
    // is the one that was actually signed and the two cannot drift.
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }, requestId);
}
