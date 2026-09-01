import type { PartnerScope } from "../_shared/partnerScopes.ts";
import type { LimiterRiskClass } from "../_shared/partnerApiMetering.ts";

/**
 * The set of scopes that SATISFIES each action. null = no scope required;
 * undefined = unknown action.
 *
 * A SET, not a single scope, because two vocabularies coexist (decision D3):
 * the frozen provider-prefixed strings and the generic v1 ones. A key reissued
 * with generic scopes must still be able to call the frozen alias, so the
 * alias's actions accept either.
 *
 * This is deliberately NOT a mapping between the vocabularies. Nothing here
 * converts `whatsapp:template.send` into `messages:send`; the two merely both
 * satisfy this one action. The difference matters: when /v1 lands and
 * something requires `messages:send` for free-form messaging, a legacy-scoped
 * key is refused, because the legacy string appears in no set but this one.
 * See _shared/partnerScopes.ts for why that containment is the whole point.
 *
 * Exported so router.test.ts can prove this map and ACTION_RISK_CLASSES never
 * drift apart — an action missing from either would be a silent policy gap.
 */
export const ACTION_SCOPES: Record<string, readonly PartnerScope[] | null> = {
  get_status: null,
  send_template: ["whatsapp:template.send", "messages:send"],
  list_templates: ["whatsapp:templates.read", "templates:read"],
  // The /v1 read surface (deliverables 2.3-2.6). Generic scopes only: no
  // legacy string satisfies any of them, because a legacy scope is frozen at
  // the capability it had when D3 froze it, and none of these existed then.
  // Adding one here would be the same escalation D3 was rewritten to prevent.
  //
  // These are /v1 ROUTE policies, not alias actions -- see ALIAS_ACTIONS.
  list_accounts: ["accounts:read"],
  get_account: ["accounts:read"],
  list_conversations: ["conversations:read"],
  get_conversation: ["conversations:read"],
  list_conversation_messages: ["messages:read"],
  get_message: ["messages:read"],
  // Phase 4. `upload_media` is a WRITE -- it stores bytes the workspace is
  // billed for -- so it takes media:write, not media:read.
  upload_media: ["media:write"],
  get_media: ["media:read"],
};

/** D7 limiter-failure risk class per action, next to ACTION_SCOPES so an
 *  action cannot be added without someone also choosing its class:
 *
 *  A — bounded local read (Postora DB only, bounded page, no outbound call)
 *  B — external or unbounded (outbound provider call, media download, unbounded set)
 *  C — mutation or amplifier (state change, customer-reaching effect, upload)
 *
 *  get_status reads local social_accounts fields (A); list_templates calls the
 *  Meta Graph API (B); send_template spends money and reaches a customer (C). */
export const ACTION_RISK_CLASSES: Record<string, LimiterRiskClass> = {
  get_status: "A",
  list_templates: "B",
  send_template: "C",
  // Every /v1 read is class A: Postora's own database, a set bounded by the
  // key's binding, a bounded page, no outbound call. Class A proceeds through
  // a limiter outage on purpose -- a read that costs nothing and reaches no
  // customer should not become collateral damage of a database incident,
  // which is the asymmetry D7 exists to encode.
  list_accounts: "A",
  get_account: "A",
  list_conversations: "A",
  get_conversation: "A",
  list_conversation_messages: "A",
  get_message: "A",
  // An upload is class C: it is a mutation with a durable, billable effect,
  // so a limiter outage must refuse it rather than let it through unmetered.
  // Reading media metadata is a bounded local read like every other 2.3-2.6
  // route.
  upload_media: "C",
  get_media: "A",
};

/**
 * The actions the FROZEN ALIAS accepts. D1 sunsets that door and forbids new
 * actions on it, so this list is closed.
 *
 * It is not a redundant copy of ACTION_SCOPES' keys, and the difference is
 * the entire point. index.ts used to treat "present in ACTION_SCOPES" as
 * "this is an alias action", then dispatch through an if-ladder with NO final
 * else -- so a known-but-unhandled action fell through to the send path. The
 * moment /v1 added a route policy, an alias request of
 * `{action: "list_conversations", recipient_phone, template_name}` would have
 * reached the provider: past the 0A suspension, which only recognises
 * `send_template`, and past the Idempotency-Key requirement, which
 * `isSendAction` imposes on that same single name. An unsuspended,
 * non-idempotent template send, opened by adding a row to a READ policy
 * table.
 *
 * The allowlist closes that permanently: the alias answers `unknown_action`
 * for anything outside it, however ACTION_SCOPES later grows.
 */
export const ALIAS_ACTIONS = ["get_status", "list_templates", "send_template"] as const;

export function isAliasAction(action: string): boolean {
  return (ALIAS_ACTIONS as readonly string[]).includes(action);
}

/**
 * ── 0A SAFETY SUSPENSION SWITCH ──────────────────────────────────────────
 *
 * `send_template` is DELIBERATELY suspended as a safety measure (decision
 * record: docs/decisions/2026-08-30-suspend-send-template.md).
 *
 * Why: the D13 duplicate-send window is real and unfixed. A process death
 * between the Meta call and the durable idempotency settle can deliver the
 * same WhatsApp message twice, and nothing in the current build closes that
 * window. The action is therefore refused in code rather than relying on the
 * three unrelated accidents that happen to block it today.
 *
 * ⚠️ RESTORATION IS GATED, NOT CASUAL. This may be flipped back to `false`
 * ONLY when the Phase 3 D13 pre-call dispatch boundary has been implemented
 * AND its gate has passed — a durable dispatch intent written BEFORE the
 * provider call, with a reconciler that makes "process died mid-send"
 * distinguishable from "never sent". Until that exists, restoring this is
 * re-arming a known duplicate-send defect against real customers.
 *
 * Flipping this one value is the ENTIRE restoration: nothing else needs to be
 * deleted. The action keeps its scope requirement, its risk class, and its
 * send-action treatment in ACTION_SCOPES / ACTION_RISK_CLASSES / isSendAction
 * precisely so the suspension is a policy state, not an amnesia about the
 * action's existence — a suspended action must answer
 * `temporarily_unavailable`, never `unknown_action`.
 */
export const SEND_TEMPLATE_SUSPENDED = true;

/** Whether an action is currently withdrawn by the 0A safety suspension.
 *  Kept per-action in the router, beside the scope and risk-class policies,
 *  so every policy an action carries is visible in this one file. */
export function isActionSuspended(action: string): boolean {
  return action === "send_template" && SEND_TEMPLATE_SUSPENDED;
}

/** The scopes that satisfy `action`: null if it needs none, undefined if the
 *  action is unknown. */
export function satisfyingScopesFor(
  action: string,
): readonly PartnerScope[] | null | undefined {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an action
  // named "toString" or "constructor" would resolve as a known action.
  return Object.hasOwn(ACTION_SCOPES, action) ? ACTION_SCOPES[action] : undefined;
}

export function limiterRiskClassFor(action: string): LimiterRiskClass | undefined {
  // Same prototype-chain guard as satisfyingScopesFor. undefined reaches
  // checkRateLimit, which fails unclassified actions CLOSED on limiter
  // failure — never fail-open by omission.
  return Object.hasOwn(ACTION_RISK_CLASSES, action) ? ACTION_RISK_CLASSES[action] : undefined;
}

/** Send actions cost money and reach a real customer, so they demand an
 *  Idempotency-Key and consume quota. Reads do neither. */
export function isSendAction(action: string): boolean {
  return action === "send_template";
}
