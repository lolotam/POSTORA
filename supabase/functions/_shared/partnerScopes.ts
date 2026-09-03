// Partner API scope vocabularies and the per-action authorisation rule
// (deliverable 1.6, decision D3).
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// D3 was rewritten once already, because its first version was privilege
// escalation dressed as a vocabulary migration. v1.0 proposed mapping
// `whatsapp:template.send` to `messages:send` while leaving the old strings
// valid. That is not a rename: the legacy scope authorises WhatsApp *template*
// sending specifically, while `messages:send` covers free-form messages and,
// under D4, any newly bound account on any platform. A credential would have
// silently gained authority its holder never asked for.
//
// So there is NO MAPPING BETWEEN VOCABULARIES anywhere in this file, and there
// must never be one. What exists instead is a per-ACTION rule: each action
// declares the set of scopes that satisfy it. Two vocabularies can both appear
// in that set without either being convertible into the other.
//
// ---------------------------------------------------------------------------
// THE TRAP, STATED SO IT CANNOT BE FILLED IN LATER BY ACCIDENT
// ---------------------------------------------------------------------------
// `whatsapp:webhooks.manage` authorises NOTHING. Not "nothing yet" as an
// oversight -- no action exists behind it and none is intended to. It is held
// only by a key that no longer exists.
//
// When the webhook API arrives, the obvious-looking move is to let it satisfy
// `webhooks:manage`. That single line would convert ZERO capability into full
// webhook CRUD plus an outbound test endpoint -- an SSRF-capable, class-C
// surface -- for any key holding a scope that has never authorised anything.
// That is exactly the escalation D3 was rewritten to prevent, arriving through
// a different door.
//
// It is therefore written below as an explicit empty capability with a test
// asserting it grants nothing, rather than as an absence a future reader fills
// in. An absence looks like an oversight; an empty list with a comment looks
// like a decision, because it is one.

/** The v1 vocabulary. MUST equal `components.schemas.GenericScope` in
 *  docs/api/openapi.yaml -- partnerScopes.test.ts reads the document and
 *  asserts it, so the published contract and the enforced vocabulary cannot
 *  drift apart. Values come from the spec's section 7 endpoint table; adding
 *  one is a capability grant and a deliberate review, never a convenience. */
export const GENERIC_SCOPES = [
  "accounts:read",
  "connectors:manage",
  "connectors:read",
  "conversations:read",
  "media:read",
  "media:write",
  "messages:read",
  "messages:send",
  "posts:publish",
  "posts:read",
  "posts:schedule",
  "posts:write",
  "templates:read",
  "tools:execute",
  "usage:read",
  "webhooks:manage",
  "webhooks:read",
] as const;

/** The frozen provider-prefixed vocabulary. Accepted at exactly the capability
 *  it has today, never widened, and refused for new keys (D3 step 3). */
export const LEGACY_SCOPES = [
  "whatsapp:template.send",
  "whatsapp:templates.read",
  "whatsapp:webhooks.manage",
] as const;

export type GenericScope = typeof GENERIC_SCOPES[number];
export type LegacyScope = typeof LEGACY_SCOPES[number];
export type PartnerScope = GenericScope | LegacyScope;

/**
 * What each LEGACY scope authorises, enumerated rather than inferred, because
 * one of the three grants nothing and inference would quietly give it
 * something.
 *
 * This is the D3(R3) allowlist. It is the capability itself, not a mapping:
 * nothing here converts a legacy scope into a generic one, and a legacy scope
 * satisfies a requirement ONLY by appearing in that action's own set below.
 */
export const LEGACY_SCOPE_CAPABILITY: Readonly<Record<LegacyScope, readonly string[]>> = {
  "whatsapp:template.send": ["send_template"],
  "whatsapp:templates.read": ["list_templates"],
  // Deliberately empty. See the trap above. Do not populate this.
  "whatsapp:webhooks.manage": [],
};

export function isGenericScope(scope: string): scope is GenericScope {
  return (GENERIC_SCOPES as readonly string[]).includes(scope);
}

export function isLegacyScope(scope: string): scope is LegacyScope {
  return (LEGACY_SCOPES as readonly string[]).includes(scope);
}

/**
 * Whether a scope string may be stored on a NEWLY MINTED key.
 *
 * Legacy strings are refused (D3 step 3). D3's step 2 -- reissuing the one
 * existing key with generic scopes -- has no subject: `pk_live_urCb` is
 * revoked and there are zero active keys, so nothing needs migrating and the
 * refusal can be unconditional.
 *
 * An UNRECOGNISED string is refused for a different reason: a stored scope
 * nobody recognises is a capability nobody can reason about. It would sit in
 * the array looking authoritative, satisfy nothing, and mean whatever the next
 * person assumes it means.
 */
export function scopeIsMintable(scope: string): boolean {
  return isGenericScope(scope);
}

export function describeScopeRejection(scope: string): string {
  if (isLegacyScope(scope)) {
    return `"${scope}" is a legacy scope, frozen at its current capability and not issuable to ` +
      "new keys (decision D3). Use the generic equivalent for the capability you actually want.";
  }
  return `"${scope}" is not a recognised scope. Allowed: ${GENERIC_SCOPES.join(", ")}`;
}
