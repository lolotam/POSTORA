import type { PartnerScope } from "../_shared/partnerApiKeys.ts";
import type { LimiterRiskClass } from "../_shared/partnerApiMetering.ts";

/** null = no scope required; undefined = unknown action. Exported so
 *  router.test.ts can prove this map and ACTION_RISK_CLASSES never drift
 *  apart — an action missing from either would be a silent policy gap. */
export const ACTION_SCOPES: Record<string, PartnerScope | null> = {
  get_status: null,
  send_template: "whatsapp:template.send",
  list_templates: "whatsapp:templates.read",
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

export function requiredScopeFor(action: string): PartnerScope | null | undefined {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an action
  // named "toString" or "constructor" would resolve as a known action.
  return Object.hasOwn(ACTION_SCOPES, action) ? ACTION_SCOPES[action] : undefined;
}

export function limiterRiskClassFor(action: string): LimiterRiskClass | undefined {
  // Same prototype-chain guard as requiredScopeFor. undefined reaches
  // checkRateLimit, which fails unclassified actions CLOSED on limiter
  // failure — never fail-open by omission.
  return Object.hasOwn(ACTION_RISK_CLASSES, action) ? ACTION_RISK_CLASSES[action] : undefined;
}

/** Send actions cost money and reach a real customer, so they demand an
 *  Idempotency-Key and consume quota. Reads do neither. */
export function isSendAction(action: string): boolean {
  return action === "send_template";
}
