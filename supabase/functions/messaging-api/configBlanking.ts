// Which stored fields a config payload would empty.
//
// On 2026-08-30 the settings form submitted its blank defaultConfig over a live
// persona, twice, and every client-side guard passed: `configLoaded` proves the
// form matches the ACCOUNT, not that it reflects user intent. This is the check
// that does not depend on the client being right, because the client is the
// layer that failed -- twice, the second time with the fix from the first
// outage already deployed.

/** Fields whose accidental clearing costs the user real work. */
export const GUARDED_FIELDS = ["persona_instructions", "business_profile_text"] as const;

export type GuardedField = (typeof GUARDED_FIELDS)[number];

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/**
 * The guarded fields this payload would empty.
 *
 * A field absent from `updates` cannot clear anything -- ai_upsert_config builds
 * `updates` only from keys present in the request, and PostgREST writes only the
 * columns it is given -- so absence is never reported. Emptying an already-empty
 * field is a no-op, and a first save (`stored === null`) has nothing to protect:
 * refusing it would block config creation exactly as the 2026-08-28 SET NOT NULL
 * did, for 52 accounts across 20 logins.
 */
export function blankedFields(
  updates: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): GuardedField[] {
  if (!stored) return [];
  return GUARDED_FIELDS.filter(
    (field) => field in updates && isBlank(updates[field]) && !isBlank(stored[field]),
  );
}
