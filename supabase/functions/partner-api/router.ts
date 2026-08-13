import type { PartnerScope } from "../_shared/partnerApiKeys.ts";

/** null = no scope required; undefined = unknown action. */
const ACTION_SCOPES: Record<string, PartnerScope | null> = {
  get_status: null,
  send_template: "whatsapp:template.send",
  list_templates: "whatsapp:templates.read",
};

export function requiredScopeFor(action: string): PartnerScope | null | undefined {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an action
  // named "toString" or "constructor" would resolve as a known action.
  return Object.hasOwn(ACTION_SCOPES, action) ? ACTION_SCOPES[action] : undefined;
}

/** Send actions cost money and reach a real customer, so they demand an
 *  Idempotency-Key and consume quota. Reads do neither. */
export function isSendAction(action: string): boolean {
  return action === "send_template";
}
