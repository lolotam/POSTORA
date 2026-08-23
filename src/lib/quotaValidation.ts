/**
 * Shared quota-input validation for every admin quota editor
 * (AdminUsers.tsx, AdminPlanQuotas.tsx, AdminPlans.tsx).
 *
 * F8 (CodeRabbit round 1, 2026-08-23): each editor used a local
 * `parseInt(raw, 10)`-based parser that silently coerced bad input instead
 * of rejecting it — `parseInt("-1.5", 10) === -1` (the unlimited sentinel
 * a typo could accidentally grant) and `parseInt("0.5", 10) === 0` (a real,
 * enforced zero the admin never typed). An empty field still means
 * "inherit" (null, no error); only a non-integer or a value below -1 is
 * rejected, with a message the caller can show next to the field.
 *
 * R4 (CodeRabbit round 2, 2026-08-23): the quota columns are Postgres
 * `integer` (max 2147483647). A value above that max used to pass this
 * validator and only fail (or overflow) once it reached the database, far
 * from where the admin typed it - reject it here instead.
 */
export const QUOTA_FIELD_ERROR_MESSAGE =
  "Enter a whole number from -1 to 2147483647 (use -1 for unlimited), or leave empty to inherit.";

// PostgreSQL `integer` max. Every user_quotas/subscription_plans quota
// column is `integer`, not `bigint` - see supabase/migrations/20260823140000.
const POSTGRES_INTEGER_MAX = 2147483647;

export interface QuotaFieldValidation {
  value: number | null;
  error: string | null;
}

export function validateQuotaFieldInput(raw: string): QuotaFieldValidation {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  if (!/^-?\d+$/.test(trimmed)) {
    return { value: null, error: QUOTA_FIELD_ERROR_MESSAGE };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < -1 || parsed > POSTGRES_INTEGER_MAX) {
    return { value: null, error: QUOTA_FIELD_ERROR_MESSAGE };
  }
  return { value: parsed, error: null };
}

/** Convenience wrapper for call sites that only need the parsed value
 *  (e.g. an untouched-so-far default like AdminPlans.tsx's create form). */
export function parseQuotaFieldInput(raw: string): number | null {
  return validateQuotaFieldInput(raw).value;
}
