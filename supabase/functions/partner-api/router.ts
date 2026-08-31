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
};

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
