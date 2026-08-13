// WhatsApp operations shared by the JWT door (messaging-api) and the key door
// (partner-api). The context is deliberately role-free: each door authorizes
// in its own terms before constructing one.

const GRAPH_API = "https://graph.facebook.com/v22.0";

export interface WhatsAppOpsContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  accountId: string;
  ownerId: string;
  workspaceId: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface SendTemplateInput {
  recipientPhone: string;
  templateName: string;
  templateLanguage: string;
  components?: unknown[];
}

export interface SendResult {
  messageId: string;
  /** False when Meta accepted the send but Postora failed to record it. */
  persisted: boolean;
  /**
   * The raw Meta body. messaging-api passes this through as `data` to keep
   * the existing frontend contract; partner-api must NOT return it, because
   * partners get a normalized response only (spec 5.3).
   */
  raw: unknown;
}

export interface TemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string;
  // WhatsAppTemplatesContent.tsx renders headers, buttons, and body previews
  // from this. Dropping it would break the template UI the moment the
  // messaging-api list handler is repointed at this op.
  components: unknown[];
}

export class WhatsAppOpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly metaCode?: number,
    /**
     * True when we cannot prove Meta did NOT accept the message.
     *
     * This distinction decides whether the caller may refund quota and settle
     * the request as a clean failure. A 4xx with a specific Meta code is a
     * definite rejection. A 5xx, a missing message id, or a body we could not
     * parse are NOT: the message may be on its way to a real customer, so the
     * request must become non-resendable and keep its quota unit.
     */
    public readonly indeterminate: boolean = false,
  ) {
    super(message);
    this.name = "WhatsAppOpError";
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Read a JSON body under its own deadline.
 *
 * An AbortController on fetch() stops covering the exchange once response
 * headers arrive, so a peer that sends headers and then stalls the body would
 * hang the request past every timeout we set. Returns {} on failure, which the
 * callers already treat as an unparseable response.
 */
// deno-lint-ignore no-explicit-any
async function readJsonWithin(response: Response, ms: number): Promise<any> {
  try {
    return await Promise.race([
      response.json(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("body read timed out")), ms)
      ),
    ]);
  } catch {
    // Callers already treat an empty object as an unparseable response.
    return {};
  }
}

/**
 * Meta is the authority on messaging policy, so we send and translate its
 * errors rather than pre-judging locally against our own message history,
 * which can be incomplete and cannot model every window variant.
 */
function translateMetaError(status: number, payload: Record<string, unknown>): WhatsAppOpError {
  const err = (payload.error ?? {}) as Record<string, unknown>;
  const metaCode = typeof err.code === "number" ? err.code : undefined;
  const message = String(err.message ?? "WhatsApp send failed");

  switch (metaCode) {
    case 131047:
      return new WhatsAppOpError(
        "Recipient has not messaged in the last 24h — send an approved template.",
        "outside_session_window", 422, metaCode,
      );
    case 132000:
    case 132001:
    case 132005:
    case 132007:
      return new WhatsAppOpError(
        `Template rejected by Meta: ${message}`,
        "template_not_approved", 422, metaCode,
      );
    case 131026:
      return new WhatsAppOpError(
        "Recipient is not reachable on WhatsApp.",
        "invalid_recipient", 422, metaCode,
      );
    case 190:
      return new WhatsAppOpError(
        "WhatsApp access token is invalid or expired — reconnect the account.",
        "account_needs_reauth", 401, metaCode,
      );
    default:
      // A 5xx tells us Meta failed to RESPOND, not that it failed to accept.
      return status >= 500
        ? new WhatsAppOpError(message, "meta_error", 502, metaCode, true)
        : new WhatsAppOpError(message, "meta_error", 422, metaCode, false);
  }
}

/**
 * Register a phone number on the Cloud API. Moved verbatim from
 * messaging-api so both doors keep the Coexistence self-heal behaviour.
 */
async function registerWhatsAppPhone(
  phoneNumberId: string,
  token: string,
  fetcher: Fetcher,
): Promise<void> {
  const pin = Deno.env.get("WHATSAPP_VERIFY_PIN") || "000000";
  // Timed like the send: this call sits BETWEEN the two message posts on the
  // auto-registration path, so an untimed hang here would strand the whole
  // request and leave its idempotency row in `processing`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const res = await fetcher(`${GRAPH_API}/${phoneNumberId}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  // Bounded like the send path: the abort timer stops covering the exchange
  // once headers arrive, so a stalled body would hang past every timeout.
  const data = await readJsonWithin(res, 10_000);
  if (!res.ok || data.error) {
    const err = data.error || {};
    // Subcode 2388001: two-step verification is on in the WhatsApp Business app.
    if (err.code === 100 && err.error_subcode === 2388001) {
      throw new WhatsAppOpError(
        "Two-step verification is enabled on the WhatsApp Business mobile app for " +
          "this number. Turn it off under Settings → Account → Two-step verification, " +
          "then try again.",
        "account_needs_reauth", 409, 2388001,
      );
    }
    throw new WhatsAppOpError(
      `Phone registration failed: ${JSON.stringify(err)}`,
      "account_not_connected", 409, err.code,
    );
  }
}

export async function sendTemplate(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  fetcher: Fetcher = fetch,
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.templateLanguage },
      components: input.components ?? [],
    },
  };

  // A hung Graph request must not outlive the function: if the runtime kills
  // us mid-flight, the idempotency row stays `processing` forever and that
  // key is poisoned.
  //
  // Worst case on the auto-registration path is send(30s) + register(15s) +
  // retry(30s) = 75s. Two constraints bind these numbers:
  //   1. the edge runtime's own request limit must exceed 75s;
  //   2. the idempotency LEASE (300s) must exceed 75s by a wide margin, or a
  //      still-running request loses its claim and a retry sends a duplicate.
  // If you shorten the lease or lengthen these timeouts, re-check both.
  const post = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    return fetcher(`${GRAPH_API}/${ctx.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  };

  let response = await post();
  // The abort timer is cleared when the response HEADERS arrive, so a peer
  // that stalls the BODY could still hang us. Bound the body read too.
  let body = await readJsonWithin(response, 10_000);

  // Coexistence numbers are not on the Cloud API until first registered.
  // Register once and retry, exactly as messaging-api does today.
  const needsRegistration = body?.error?.code === 133010 ||
    (body?.error?.code === 100 && body?.error?.error_subcode === 33);

  if (needsRegistration) {
    await registerWhatsAppPhone(ctx.phoneNumberId, ctx.accessToken, fetcher);
    response = await post();
    body = await readJsonWithin(response, 10_000);
  }

  if (!response.ok || body?.error) throw translateMetaError(response.status, body);

  const messageId = body?.messages?.[0]?.id;
  if (!messageId) {
    // Meta returned 2xx, so it very likely accepted the message; we simply
    // cannot name it. Never treat this as a rejection.
    throw new WhatsAppOpError(
      "Meta accepted the send but returned no message id",
      "meta_error", 502, undefined, true,
    );
  }

  const persisted = await persistOutbound(ctx, input, messageId);
  return { messageId, persisted, raw: body };
}

/**
 * Record the outbound message AND surface the conversation in the inbox.
 * Returns false rather than throwing: Meta has already accepted the message,
 * so a storage failure must not be reported to the caller as a failed send.
 */
async function persistOutbound(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  messageId: string,
): Promise<boolean> {
  const preview = `[Template: ${input.templateName}]`;
  const normalizedPhone = input.recipientPhone.replace(/^\+/, "");
  const conversationId = `wa_${ctx.phoneNumberId}_${normalizedPhone}`;

  const { error } = await ctx.admin.from("whatsapp_messages").insert({
    user_id: ctx.ownerId,
    social_account_id: ctx.accountId,
    conversation_id: conversationId,
    message_id: messageId,
    from_phone: ctx.phoneNumberId,
    from_name: "You",
    to_phone: input.recipientPhone,
    message_text: preview,
    message_type: "template",
    direction: "outbound",
    status: "sent",
    timestamp: new Date().toISOString(),
  });

  if (error) {
    console.error("[whatsappPartnerOps] message persist failed:", error.message);
    return false;
  }

  // Without this the message is stored but the conversation never appears in
  // the inbox — the exact regression this task's header warns about.
  return await upsertOutboundConversation(ctx.admin, {
    user_id: ctx.ownerId,
    social_account_id: ctx.accountId,
    workspace_id: ctx.workspaceId,
    phone_number_id: ctx.phoneNumberId,
    recipient_phone: input.recipientPhone,
    preview,
  });
}

/**
 * Moved from messaging-api/index.ts:35. Copy the body verbatim — it upserts
 * the contact and the conversation row — changing only the signature to
 * return a boolean instead of swallowing failures silently.
 *
 * NOTE: it normalizes with replace(/\D/g, "") while the message insert above
 * uses replace(/^\+/, ""). Preserve both as they are; unifying them would
 * change existing conversation_id values. Flagged in the spec, not fixed here.
 */
export async function upsertOutboundConversation(
  // deno-lint-ignore no-explicit-any
  admin: any,
  params: {
    user_id: string;
    social_account_id: string;
    workspace_id: string;
    phone_number_id: string;
    recipient_phone: string;
    preview: string;
  },
): Promise<boolean> {
  const normalizedPhone = params.recipient_phone.replace(/\D/g, "");
  const conversationId = `wa_${params.phone_number_id}_${normalizedPhone}`;
  const nowIso = new Date().toISOString();

  const { data: existingContact } = await admin
    .from("whatsapp_contacts")
    .select("display_name")
    .eq("workspace_id", params.workspace_id)
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  const participantName = existingContact?.display_name || `+${normalizedPhone}`;

  // Auto-save contact (no-op on conflict).
  const { error: contactError } = await admin.from("whatsapp_contacts").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      phone_number: normalizedPhone,
      display_name: participantName,
      last_message_at: nowIso,
    },
    { onConflict: "user_id,phone_number", ignoreDuplicates: false },
  );

  // messaging_cache is what makes the conversation show up in the inbox.
  const { error: cacheError } = await admin.from("messaging_cache").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      social_account_id: params.social_account_id,
      platform: "whatsapp",
      conversation_id: conversationId,
      participant_name: participantName,
      last_message_preview: params.preview.slice(0, 200),
      last_message_at: nowIso,
      unread_count: 0,
      updated_at: nowIso,
    },
    { onConflict: "user_id,conversation_id" },
  );

  if (contactError || cacheError) {
    console.error(
      "[whatsappPartnerOps] conversation upsert failed:",
      contactError?.message ?? cacheError?.message,
    );
    return false;
  }
  return true;
}

export async function listTemplates(
  ctx: WhatsAppOpsContext,
  wabaId: string,
  fetcher: Fetcher = fetch,
): Promise<TemplateSummary[]> {
  // Keep the explicit field selection the current handler uses
  // (messaging-api/index.ts:1025); without `fields=` Meta omits `components`,
  // which the template UI renders.
  // Timed and body-bounded like the send path: a read has no side effect, but
  // an untimed one still hangs the request and burns the runtime's budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const response = await fetcher(
    `${GRAPH_API}/${wabaId}/message_templates` +
      `?fields=name,status,category,language,components&limit=100`,
    {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
      signal: controller.signal,
    },
  ).finally(() => clearTimeout(timer));
  const body = await readJsonWithin(response, 10_000);
  if (!response.ok) throw translateMetaError(response.status, body);

  // deno-lint-ignore no-explicit-any
  return (body.data ?? []).map((t: any) => ({
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    components: t.components ?? [],
  }));
}
