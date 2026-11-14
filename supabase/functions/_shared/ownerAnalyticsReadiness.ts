/** Database-only readiness evidence. Collection eligibility is independent of saved measurements. */
export const COLLECTION_REASONS = [
  "collection_disabled", "collection_not_eligible", "bootstrap_required", "permission_verification_pending",
  "stored_user_credential_missing", "token_invalid", "reconnect_required", "permission_missing",
  "app_mismatch", "identity_mismatch", "account_identity_invalid", "account_inactive",
  "queued", "running", "awaiting_first_capture", "rate_limited", "provider_error",
  "settings_unavailable", "audit_unavailable", "ready",
] as const;
export type CollectionReason = typeof COLLECTION_REASONS[number];
export const COLLECTION_STATES = ["not_enabled", "preparing", "needs_reconnect", "permissions_missing", "needs_review", "syncing", "unavailable", "ready"] as const;
export const NEXT_ACTIONS = ["contact_support", "wait", "reconnect", "grant_permissions", "retry_after", "none"] as const;
export type OwnerAnalyticsReadiness = {
  collection: {
    contract_version: 2; state: typeof COLLECTION_STATES[number]; reason_code: CollectionReason;
    reason_source: "configuration" | "rollout_policy" | "connection" | "capability" | "permission" | "job" | "data";
    observed_at: string; next_action: typeof NEXT_ACTIONS[number]; reconnect_can_help: boolean;
    retry_at: string | null; support_correlation_id: string;
  };
  connection: { state: "verified" | "unverified" | "invalid"; reason_code: CollectionReason | null };
  permission: { state: "verified" | "missing" | "unknown" | "unavailable"; observed_at: string | null; missing_scopes: string[] };
  last_attempt: { state: string; reason_code: string | null; observed_at: string | null } | null;
};
export type OwnerAnalyticsData = {
  state: "empty" | "partial" | "complete" | "stale";
  observation_count: number; coverage: "unknown" | "partial" | "complete";
  last_successful_capture: string | null;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableInstant = (value: unknown) => value === null || instant(value);
const member = (values: readonly string[], value: unknown) => typeof value === "string" && values.includes(value);

/** Reject missing/malformed evidence rather than silently treating it as empty or denied. */
export function parseOwnerAnalyticsReadiness(value: unknown): OwnerAnalyticsReadiness {
  if (!record(value) || !record(value.collection) || !record(value.connection) || !record(value.permission)) throw new TypeError("Invalid owner analytics readiness");
  const { collection: c, connection: n, permission: p, last_attempt: a } = value;
  if (c.contract_version !== 2 || !member(COLLECTION_STATES, c.state) || !member(COLLECTION_REASONS, c.reason_code)
    || !member(["configuration", "rollout_policy", "connection", "capability", "permission", "job", "data"], c.reason_source)
    || !instant(c.observed_at) || !member(NEXT_ACTIONS, c.next_action) || typeof c.reconnect_can_help !== "boolean"
    || !nullableInstant(c.retry_at) || typeof c.support_correlation_id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(c.support_correlation_id)
    || !member(["verified", "unverified", "invalid"], n.state) || !(n.reason_code === null || member(COLLECTION_REASONS, n.reason_code))
    || !member(["verified", "missing", "unknown", "unavailable"], p.state) || !nullableInstant(p.observed_at)
    || !Array.isArray(p.missing_scopes) || p.missing_scopes.length > 8 || p.missing_scopes.some((scope) => typeof scope !== "string" || !/^[a-z_]{1,80}$/.test(scope))
    || (p.state !== "missing" && p.missing_scopes.length !== 0)
    || (a !== null && (!record(a) || typeof a.state !== "string" || a.state.length > 80 || !(a.reason_code === null || typeof a.reason_code === "string" && a.reason_code.length <= 120) || !nullableInstant(a.observed_at)))) {
    throw new TypeError("Invalid owner analytics readiness");
  }
  // A positive provider denial may not identify an individual required scope.
  // Accept no scope names only with the matching dated job evidence.
  const providerDenial = c.reason_source === "job" && record(a) && a.state === "failed" && a.reason_code === "permission_missing"
    && instant(a.observed_at) && instant(p.observed_at) && Date.parse(a.observed_at) === Date.parse(p.observed_at);
  if (p.state === "missing" && (p.observed_at === null || p.missing_scopes.length === 0 && !providerDenial)
    || c.reason_code === "permission_missing" && p.state !== "missing"
    || c.reconnect_can_help !== ["reconnect", "grant_permissions"].includes(String(c.next_action))
    || ["collection_disabled", "collection_not_eligible", "bootstrap_required"].includes(String(c.reason_code)) && c.reconnect_can_help) {
    throw new TypeError("Contradictory owner analytics readiness");
  }
  // Return only the public allowlisted projection, never arbitrary snapshot fields.
  return { collection: { contract_version: 2, state: c.state, reason_code: c.reason_code, reason_source: c.reason_source,
    observed_at: c.observed_at, next_action: c.next_action, reconnect_can_help: c.reconnect_can_help,
    retry_at: c.retry_at, support_correlation_id: c.support_correlation_id },
    connection: { state: n.state, reason_code: n.reason_code }, permission: { state: p.state, observed_at: p.observed_at, missing_scopes: p.missing_scopes },
    last_attempt: record(a) ? { state: a.state, reason_code: a.reason_code, observed_at: a.observed_at } : null } as OwnerAnalyticsReadiness;
}

export function ownerAnalyticsData(input: { count: number; complete: boolean; lastCapture: string | null; now: string; staleAfterMs: number }): OwnerAnalyticsData {
  const coverage = input.count === 0 ? "unknown" : input.complete ? "complete" : "partial";
  return { state: input.count === 0 ? "empty" : !input.complete ? "partial"
    : input.lastCapture !== null && Date.parse(input.now) - Date.parse(input.lastCapture) > input.staleAfterMs ? "stale" : "complete",
    observation_count: input.count, coverage, last_successful_capture: input.count === 0 ? null : input.lastCapture };
}
