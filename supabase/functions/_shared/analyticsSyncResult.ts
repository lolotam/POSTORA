import { COLLECTION_REASONS, type CollectionReason } from "./ownerAnalyticsReadiness.ts";
import { z } from "npm:zod@4.1.12";
import { AGENT_DATA_NOTICE, untrustedAnalyticsFields } from "./analyticsAgentResult.ts";

export const analyticsSyncResultSchema = z.object({
  contract_version: z.literal(2), transport_status: z.number().int().min(100).max(599),
  ok: z.boolean(), accepted: z.boolean(), queued: z.boolean(), status: z.string(),
  reason_code: z.enum(COLLECTION_REASONS), reason_source: z.enum(["rollout_policy", "configuration", "capability", "job", "connection", "permission", "response", "audit"]),
  next_action: z.enum(["none", "wait", "reconnect", "grant_permissions", "retry_after", "contact_support"]),
  reconnect_can_help: z.boolean(), retry_at: z.string().datetime({ offset: true }).nullable(),
}).refine((r) => r.ok === r.accepted
  && r.queued === (r.accepted && ["queued", "pending"].includes(r.status))
  && (!r.accepted || ["queued", "running", "leased", "pending", "partial", "retry", "success", "completed"].includes(r.status))
  && (!r.accepted || r.reason_code === (["success", "completed"].includes(r.status) ? "ready"
    : r.status === "retry" ? "provider_error" : ["running", "leased", "partial"].includes(r.status) ? "running" : "queued"))
  && r.reconnect_can_help === ["reconnect", "grant_permissions"].includes(r.next_action));
export type AnalyticsSyncReceipt = z.infer<typeof analyticsSyncResultSchema>;

/** Interpret body semantics as well as HTTP status. Unknown results never promise collection. */
export function analyticsSyncReceipt(statusCode: number, value: unknown): AnalyticsSyncReceipt {
  const normalized = analyticsSyncResultSchema.safeParse(value);
  if (normalized.success && normalized.data.transport_status === statusCode) return normalized.data;
  const body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const producer = analyticsSyncResultSchema.safeParse(body.agent_result);
  if (producer.success && producer.data.transport_status === statusCode) return producer.data;
  const error = body.error !== null && typeof body.error === "object" ? (body.error as Record<string, unknown>).code : body.error;
  const status = typeof body.status === "string" ? body.status : "unavailable";
  const raw = body.reason_code ?? body.reason ?? error ?? status;
  const aliases: Readonly<Record<string, CollectionReason>> = {
    not_eligible: "collection_not_eligible", configuration_unavailable: "settings_unavailable", app_configuration_unavailable: "settings_unavailable", capability_missing: "bootstrap_required",
    reconnect_required: "bootstrap_required", credential_unavailable: "bootstrap_required", context_missing: "bootstrap_required",
    scope_missing: "permission_missing", reauth_required: "token_invalid", throttled: "rate_limited",
  };
  const reason = typeof raw === "string" ? Object.hasOwn(aliases, raw) ? aliases[raw] : COLLECTION_REASONS.includes(raw as CollectionReason) ? raw as CollectionReason : null : null;
  const accepted = statusCode >= 200 && statusCode < 300 && body.ok !== false && body.accepted !== false && body.refused !== true && body.success !== false && ["queued", "running", "leased", "pending", "partial", "retry", "success", "completed"].includes(status)
    && (reason !== null || raw === status || ["enqueued", "already_enqueued", "forced"].includes(String(raw)))
    && (!reason || ["queued", "running", "ready"].includes(reason));
  const code: CollectionReason = accepted ? status === "success" || status === "completed" ? "ready" : status === "retry" ? "provider_error" : ["running", "leased", "partial"].includes(status) ? "running" : "queued" : reason && !["queued", "running", "ready"].includes(reason) ? reason : statusCode === 429 ? "rate_limited" : "provider_error";
  const policy = ["collection_disabled", "collection_not_eligible"].includes(code);
  // A raw legacy reconnect refusal only proves absent trusted state. It does
  // not prove the available OAuth route can repair it.
  const reconnect = body.reconnect_can_help === true && ["token_invalid", "permission_missing", "stored_user_credential_missing"].includes(code);
  return analyticsSyncResultSchema.parse({ contract_version: 2, transport_status: statusCode, ok: accepted, accepted, queued: accepted && ["queued", "pending"].includes(status),
    status: policy ? "not_enabled" : accepted ? status : "unavailable", reason_code: code,
    reason_source: policy ? "rollout_policy" : code === "settings_unavailable" ? "configuration" : code === "bootstrap_required" ? "capability"
      : code === "permission_missing" ? "permission" : code === "audit_unavailable" ? "audit" : !reason && !accepted ? "response" : accepted || code === "rate_limited" ? "job" : "connection",
    next_action: accepted ? code === "ready" ? "none" : status === "retry" ? "retry_after" : "wait" : reconnect ? code === "permission_missing" ? "grant_permissions" : "reconnect" : code === "rate_limited" ? "retry_after" : "contact_support",
    reconnect_can_help: reconnect, retry_at: z.string().datetime({ offset: true }).safeParse(body.retry_at ?? body.next_retry_at).success ? body.retry_at ?? body.next_retry_at : null });
}

/** Both MCP text and structured content carry the same safe receipt. Reports stay successful reads. */
export function analyticsToolResult(status: number, value: unknown, mutation = false) {
  const body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const structuredContent = mutation ? { ...body, ...analyticsSyncReceipt(status, body) } : body;
  const failed = status >= 400 || mutation && structuredContent.ok !== true || !mutation && (Object.keys(body).length === 0 || body.ok === false || body.success === false || Boolean(body.error));
  const output = mutation ? { ...structuredContent, notice: AGENT_DATA_NOTICE, untrusted_fields: [...untrustedAnalyticsFields],
    user_message: structuredContent.status === "not_enabled" ? "Analytics collection is not enabled for your account. Contact support; reconnecting cannot change eligibility."
      : structuredContent.accepted ? "Request accepted. Queued or running work is not a completed capture; an already completed day is not forced fresh."
      : structuredContent.reconnect_can_help ? "Use the supported connection path to restore access." : "See reason_code and next_action. Reconnect has not been established as a repair." } : structuredContent;
  return { ...(failed ? { isError: true } : {}), structuredContent: output,
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
}
