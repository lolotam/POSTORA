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
 */
export const QUOTA_FIELD_ERROR_MESSAGE =
  "Enter a whole number of -1 or greater (use -1 for unlimited), or leave empty to inherit.";

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
  if (parsed < -1) {
    return { value: null, error: QUOTA_FIELD_ERROR_MESSAGE };
  }
  return { value: parsed, error: null };
}

/** Convenience wrapper for call sites that only need the parsed value
 *  (e.g. an untouched-so-far default like AdminPlans.tsx's create form). */
export function parseQuotaFieldInput(raw: string): number | null {
  return validateQuotaFieldInput(raw).value;
}
