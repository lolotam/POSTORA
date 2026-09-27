// Production ports for the store-event worker. worker.ts stays free of I/O.
import { loadAgentConfigForAccount } from "../_shared/agentConfigLookup.ts";
import { parseCustomerPhone } from "../_shared/phone.ts";
import { resolveToolsForAccount, type ResolvableTool, type ToolAccountLink } from "../_shared/toolResolution.ts";
import { readProcedureConfig } from "../_shared/procedures/config.ts";
import {
  ensureEventTemplate,
  eventTemplateGraph,
  eventTemplateName,
  type TemplateResolution,
} from "../_shared/procedures/eventTemplates.ts";
import type { OpenerLanguage } from "../_shared/procedures/openers.ts";
import { persistProcedureState } from "../ai-agent-reply/procedureState.ts";
import { connectorCallFailed, executeProcedureStoreCall } from "../ai-agent-reply/connectorExecution.ts";
import type { CustomTool, ToolContext } from "../ai-agent-reply/tools.ts";
import { sendTemplate, sendText, WhatsAppOpError } from "../_shared/whatsappPartnerOps.ts";
import { resolveWhatsAppTransport } from "../_shared/whatsappTransport.ts";
import {
  sanitizeFailureReason,
  type AccountContext,
  type RecordOpenerInput,
  type SendOpenerInput,
  type SendOutcome,
  type StoreEventRow,
  type StoreSnapshot,
  type WorkerPorts,
} from "./worker.ts";

const TOOL_COLUMNS = "id, name, description, url, secret, admin_only, scope, social_account_id, connector_type, read_only_mode, settings, auth_strategy, connection_id";
const DAY_MS = 24 * 60 * 60 * 1000;

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  connection_mode: AccountContext["connectionMode"];
  platform_user_id: string | null;
  access_token: string | null;
  account_metadata: Record<string, unknown> | null;
  workspace_id: string | null;
}

function stringPayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const payload: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") payload[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry)) payload[key] = String(entry);
  }
  return payload;
}

function readReturned(output: string): Record<string, unknown> | null {
  const marker = "returned: ";
  const at = output.indexOf(marker);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(output.slice(at + marker.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function classifySendError(error: unknown): SendOutcome {
  if (error instanceof WhatsAppOpError) {
    return error.indeterminate
      ? { accepted: false, definite: false }
      : { accepted: false, definite: true, reason: error.message };
  }
  const message = error instanceof Error ? error.message : "send_failed";
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 0;
  if (status >= 500 || /timed out|aborted/i.test(message)) return { accepted: false, definite: false };
  return { accepted: false, definite: true, reason: message };
}

/** A QR text send with no provider message id may already be on its way. */
export function classifyQrTextResult(messageId: string | null | undefined): SendOutcome {
  if (!messageId) return { accepted: false, definite: false };
  return { accepted: true, messageId };
}

export interface StoreBindingIdentity {
  connector_id?: string;
  social_account_id?: string;
  user_id?: string;
}

/** The webhook binding must name this event's connector, account, and owner. */
export function storeBindingMatches(
  binding: StoreBindingIdentity | null,
  event: { connector_id: string; social_account_id: string; user_id: string },
): boolean {
  return Boolean(binding)
    && binding?.connector_id === event.connector_id
    && binding?.social_account_id === event.social_account_id
    && binding?.user_id === event.user_id;
}

/** Phone to look up in messaging_opt_outs. No phone means the lookup is skipped. */
export function optOutLookupPhone(phone: string | undefined): string | null {
  return phone ? phone : null;
}

/** A lookup row counts only when this event actually named a phone. */
export function optedOutFromLookup(phone: string | null, row: unknown): boolean {
  return phone !== null && row != null;
}

// deno-lint-ignore no-explicit-any
export function createStoreEventPorts(admin: any): WorkerPorts {
  async function accountRow(event: StoreEventRow): Promise<AccountRow | null> {
    const { data, error } = await admin.from("social_accounts")
      .select("id, user_id, platform, connection_mode, platform_user_id, access_token, account_metadata, workspace_id")
      .eq("id", event.social_account_id)
      .eq("user_id", event.user_id)
      .maybeSingle();
    if (error) throw error;
    return (data as AccountRow | null) ?? null;
  }

  async function wooTool(event: StoreEventRow): Promise<CustomTool | null> {
    const { data, error } = await admin.from("ai_agent_tools")
      .select(TOOL_COLUMNS)
      .eq("id", event.connector_id)
      .eq("user_id", event.user_id)
      .eq("connector_type", "woocommerce")
      .maybeSingle();
    if (error) throw error;
    return (data as CustomTool | null) ?? null;
  }

  return {
    now: () => Date.now(),
    async claim(limit, lease) {
      const { data, error } = await admin.rpc("claim_store_events", { p_limit: limit, p_lease: lease });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        user_id: String(row.user_id),
        social_account_id: String(row.social_account_id ?? ""),
        connector_id: String(row.connector_id ?? ""),
        binding_id: String(row.binding_id ?? ""),
        flow: row.flow as StoreEventRow["flow"],
        external_id: String(row.external_id ?? ""),
        payload: stringPayload(row.payload),
        status: row.status === "sending" ? "sending" : "claimed",
        claim_token: String(row.claim_token ?? ""),
        due_at: String(row.due_at ?? ""),
        outbound_message_id: typeof row.outbound_message_id === "string" ? row.outbound_message_id : null,
      }));
    },
    async updateEvent(id, claimToken, patch) {
      const { data, error } = await admin.from("store_events").update(patch).eq("id", id).eq("claim_token", claimToken).select("id");
      if (error) throw error;
      return ((data ?? []) as unknown[]).length === 1;
    },
    async releaseClaim(id, claimToken) {
      const { data, error } = await admin.from("store_events")
        .update({ status: "pending", claimed_at: null, claim_token: null })
        .eq("id", id)
        .eq("claim_token", claimToken)
        .eq("status", "claimed")
        .select("id");
      if (error) throw error;
      return ((data ?? []) as unknown[]).length === 1;
    },
    async loadAccount(event) {
      const row = await accountRow(event);
      if (!row) return null;
      const lookupPhone = optOutLookupPhone(event.payload.phone);
      const [config, bindingResult, toolResult, linkResult, optOutResult] = await Promise.all([
        loadAgentConfigForAccount(admin, { userId: event.user_id, platform: "whatsapp", accountId: row.id }),
        admin.from("store_webhook_bindings").select("id, connector_id, social_account_id, user_id").eq("id", event.binding_id).maybeSingle(),
        admin.from("ai_agent_tools").select(TOOL_COLUMNS).eq("user_id", event.user_id).eq("is_enabled", true),
        admin.from("ai_agent_tool_accounts").select("tool_id, social_account_id").eq("user_id", event.user_id).eq("social_account_id", row.id),
        lookupPhone
          ? admin.from("messaging_opt_outs").select("user_id").eq("user_id", event.user_id).eq("phone", lookupPhone).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (bindingResult.error) throw bindingResult.error;
      if (toolResult.error) throw toolResult.error;
      if (linkResult.error) throw linkResult.error;
      if (optOutResult.error) throw optOutResult.error;
      const binding = bindingResult.data as StoreBindingIdentity | null;
      const tools = (toolResult.data ?? []) as ResolvableTool[];
      const links = (linkResult.data ?? []) as ToolAccountLink[];
      const visible = resolveToolsForAccount(tools, links, row.id).tools.some((tool) => tool.id === event.connector_id);
      const bindingOk = storeBindingMatches(binding, event);
      const procedures = readProcedureConfig((config?.agent_behavior as { procedures?: unknown } | undefined)?.procedures);
      const mode = row.connection_mode ?? null;
      return {
        platform: row.platform,
        connectionMode: mode,
        phoneNumberId: mode === "evolution_qr" ? null : row.platform_user_id,
        platformUserId: row.platform_user_id ?? "",
        languageMode: config?.language_mode,
        agentEnabled: config?.is_enabled === true,
        defaultMode: typeof config?.default_mode === "string" ? config.default_mode : "",
        settings: procedures[event.flow] ?? null,
        connectorVisible: visible && bindingOk,
        optedOut: optedOutFromLookup(lookupPhone, optOutResult.data),
      };
    },
    async readStore(event) {
      const tool = await wooTool(event);
      if (!tool) return null;
      const context = {
        admin,
        userId: event.user_id,
        platform: "whatsapp",
        conversationId: event.id,
        customerName: "",
        adminPhoneNumbers: [],
        dryRun: false,
        socialAccountId: event.social_account_id,
        requestId: event.id,
        isAdmin: false,
        retrieveKnowledge: () => Promise.resolve([]),
        sendWhatsAppText: () => Promise.resolve(),
      } as ToolContext;
      const found = event.flow === "back_in_stock"
        ? await executeProcedureStoreCall(context, tool, {
          capability: "get_product",
          method: "GET",
          parameters: {
            product_id: event.payload.product_id,
            ...(event.payload.parent_id ? { parent_id: event.payload.parent_id } : {}),
          },
        })
        : await executeProcedureStoreCall(context, tool, {
          capability: "lookup_orders",
          method: "GET",
          parameters: { order_id: event.payload.order_id },
        });
      if (connectorCallFailed(found)) return null;
      const data = readReturned(found.output);
      if (!data) return null;
      return {
        paymentMethod: typeof data.payment_method === "string" ? data.payment_method : "",
        status: typeof data.status === "string" ? data.status : "",
        phone: parseCustomerPhone(typeof data.phone === "string" ? data.phone : "", typeof data.country === "string" ? data.country : null),
        createdAt: typeof data.date_created === "string" ? data.date_created : null,
        stockStatus: typeof data.stock_status === "string" ? data.stock_status : null,
      } satisfies StoreSnapshot;
    },
    async reserveQr(accountId, limit) {
      const { data, error } = await admin.rpc("reserve_qr_opener", { p_account: accountId, p_limit: limit });
      if (error) throw error;
      return data === true;
    },
    async releaseQr(accountId) {
      const { error } = await admin.rpc("release_qr_opener", { p_account: accountId });
      if (error) throw error;
    },
    async ensureThread(input) {
      const { data, error } = await admin.from("ai_threads")
        .upsert({ user_id: input.userId, platform: "whatsapp", conversation_id: input.conversationId }, { onConflict: "user_id,platform,conversation_id" })
        .select("id, procedure_state")
        .single();
      if (error) throw error;
      return { id: String(data.id), procedure_state: data.procedure_state ?? null };
    },
    persistState: (threadId, expected, next) => persistProcedureState(admin, threadId, expected, next),
    async templateStatus(event, language: OpenerLanguage): Promise<TemplateResolution> {
      const row = await accountRow(event);
      const metadata = row?.account_metadata ?? {};
      const wabaId = typeof metadata.waba_id === "string" ? metadata.waba_id : Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
      const token = row?.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "";
      const fallback = eventTemplateName(event.flow, 1);
      if (!wabaId || !token) return { status: "missing", name: fallback, language, category: "UTILITY" };
      return await ensureEventTemplate(eventTemplateGraph(wabaId, token), event.flow, language, { create: false });
    },
    async sendOpener(input: SendOpenerInput): Promise<SendOutcome> {
      const row = await accountRow(input.event);
      if (!row?.platform_user_id) return { accepted: false, definite: true, reason: "account_unavailable" };
      try {
        if (input.account.connectionMode === "evolution_qr") {
          const transport = await resolveWhatsAppTransport(admin, {
            id: row.id,
            platform_user_id: row.platform_user_id,
            access_token: row.access_token,
            account_metadata: row.account_metadata,
            connection_mode: "evolution_qr",
          });
          const result = await transport.sendText({ recipientPhone: input.event.payload.phone, text: input.text });
          return classifyQrTextResult(result.messageId);
        }
        if (!input.templateName || !row.access_token && !Deno.env.get("WHATSAPP_ACCESS_TOKEN")) {
          return { accepted: false, definite: true, reason: "account_unavailable" };
        }
        const result = await sendTemplate({
          admin,
          accountId: row.id,
          ownerId: row.user_id,
          workspaceId: row.workspace_id ?? "",
          phoneNumberId: row.platform_user_id,
          accessToken: row.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "",
          connectionMode: input.account.connectionMode,
        }, {
          recipientPhone: input.event.payload.phone,
          templateName: input.templateName,
          templateLanguage: input.language,
          components: input.components,
          recordOutbound: false,
        });
        return { accepted: true, messageId: result.messageId };
      } catch (error) {
        return classifySendError(error);
      }
    },
    async recordOpener(input: RecordOpenerInput) {
      const phoneNumberId = input.account.connectionMode === "evolution_qr"
        ? input.account.platformUserId
        : (input.account.phoneNumberId ?? input.account.platformUserId);
      const { error: messageError } = await admin.from("whatsapp_messages").insert({
        user_id: input.event.user_id,
        social_account_id: input.event.social_account_id,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        from_phone: phoneNumberId,
        from_name: "AI Agent",
        to_phone: input.event.payload.phone,
        message_text: input.text,
        message_type: input.account.connectionMode === "evolution_qr" ? "text" : "template",
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });
      if (messageError) {
        console.error(
          `[process-store-events] ${input.event.id} inbox write failed:`,
          sanitizeFailureReason(messageError.message),
        );
      }
      const { error: threadError } = await admin.from("ai_thread_messages").insert({
        thread_id: input.threadId,
        user_id: input.event.user_id,
        role: "assistant",
        content: input.text,
      });
      if (threadError) {
        console.error(
          `[process-store-events] ${input.event.id} thread write failed:`,
          sanitizeFailureReason(threadError.message),
        );
      }
    },
    async deleteWaitlist(event) {
      const waitlistId = event.external_id.startsWith("waitlist:") ? event.external_id.slice("waitlist:".length) : "";
      if (!waitlistId) return;
      const { error } = await admin.from("stock_waitlist").delete().eq("id", waitlistId).eq("user_id", event.user_id);
      if (error) {
        console.error(
          `[process-store-events] ${event.id} waitlist delete failed:`,
          sanitizeFailureReason(error.message),
        );
      }
    },
    async alertAdmin(event, reason) {
      const { error } = await admin.from("system_logs").insert({
        source: "process-store-events",
        category: "api",
        level: "warn",
        message: `Store event ${event.id} (${event.flow}) needs attention: ${reason}`,
        metadata: { event_id: event.id, flow: event.flow, reason },
      });
      if (error) {
        console.error(
          `[process-store-events] ${event.id} alert log failed:`,
          sanitizeFailureReason(error.message),
        );
      }
      const config = await loadAgentConfigForAccount(admin, {
        userId: event.user_id,
        platform: "whatsapp",
        accountId: event.social_account_id,
      });
      const phones = Array.isArray(config?.admin_phone_numbers) ? config.admin_phone_numbers as unknown[] : [];
      const row = await accountRow(event);
      if (!row || phones.length === 0) return;
      const text = `A WhatsApp store opener (${event.flow}) could not be confirmed. Event ${event.id}.`;
      for (const phone of phones) {
        if (typeof phone !== "string" || !phone) continue;
        try {
          if (row.connection_mode === "evolution_qr" && row.platform_user_id) {
            const transport = await resolveWhatsAppTransport(admin, {
              id: row.id,
              platform_user_id: row.platform_user_id,
              access_token: row.access_token,
              account_metadata: row.account_metadata,
              connection_mode: "evolution_qr",
            });
            await transport.sendText({ recipientPhone: phone, text });
          } else if (row.platform_user_id && (row.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN"))) {
            await sendText({
              admin,
              accountId: row.id,
              ownerId: row.user_id,
              workspaceId: row.workspace_id ?? "",
              phoneNumberId: row.platform_user_id,
              accessToken: row.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "",
              connectionMode: row.connection_mode,
            }, { recipientPhone: phone, body: text });
          }
        } catch {
          console.error(`[process-store-events] ${event.id} admin alert failed`);
        }
      }
    },
    async purge(nowMs) {
      const cutoff = new Date(nowMs - 30 * DAY_MS).toISOString();
      const cleared = await admin.from("store_events").update({ payload: {} }).lt("processed_at", cutoff).in("status", ["sent", "skipped", "failed"]);
      if (cleared.error) {
        console.error("[process-store-events] payload purge failed:", sanitizeFailureReason(cleared.error.message));
      }
      const dropped = await admin.from("stock_waitlist").delete().lt("expires_at", new Date(nowMs).toISOString());
      if (dropped.error) {
        console.error("[process-store-events] waitlist purge failed:", sanitizeFailureReason(dropped.error.message));
      }
    },
  };
}
