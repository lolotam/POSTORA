/**
 * The Instagram handle rules of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The normalisation and the shape validation of a tracked handle, and
 *   the length rule of the optional user label.
 *
 * WHY THE RULES ARE MIRRORED
 *
 *   The database is the authority: `normalize_competitor_username(text)`
 *   trims, removes the leading `@`, trims again and lower-cases, and the
 *   `competitor_watchlist_username_chk` constraint accepts 1-30
 *   characters of `a-z`, `0-9`, `.` and `_` with no two consecutive
 *   periods.
 *
 *   The frontend mirrors those rules so a handle that can never be
 *   tracked is refused before a round trip, and so `@Foo` and `foo` are
 *   ONE local tracking state instead of two (spec §8). The mirror is a
 *   fast pre-check only: the database still decides, and a refusal from
 *   the database is still a refusal.
 */

/** The longest handle the database accepts. */
export const INSTAGRAM_HANDLE_MAX_LENGTH = 30;

/** The longest user label the database accepts. */
export const COMPETITOR_LABEL_MAX_LENGTH = 120;

/** The shape of a normalised Instagram handle. */
export const INSTAGRAM_HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/;

/**
 * Normalises a handle exactly the way the database does.
 *
 * Trim, remove every leading `@`, trim again, lower-case. The result is
 * what the uniqueness constraint compares, so it is the identity of the
 * tracked competitor.
 */
export function normalizeInstagramHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Whether a NORMALISED handle has a shape the database accepts.
 */
export function isValidInstagramHandle(normalized: string): boolean {
  if (!INSTAGRAM_HANDLE_PATTERN.test(normalized)) return false;
  return !normalized.includes("..");
}

/** Why a handle was refused. */
export type InstagramHandleRejection = "empty" | "invalid";

/**
 * The result of a handle validation.
 *
 * The discriminant is a STRING, not a boolean: this repository compiles
 * with `strictNullChecks: false`, and TypeScript does not narrow a
 * union on a boolean literal in that mode. A string discriminant is
 * the shape that actually narrows.
 */
export type InstagramHandleValidation =
  | { readonly outcome: "valid"; readonly handle: string }
  | { readonly outcome: "invalid"; readonly reason: InstagramHandleRejection };

/**
 * Validates and normalises a handle.
 *
 * The result is a discriminated union so a caller cannot use a rejected
 * handle by accident.
 */
export function validateInstagramHandle(raw: string): InstagramHandleValidation {
  const handle = normalizeInstagramHandle(raw);
  if (handle === "") return { outcome: "invalid", reason: "empty" };
  if (!isValidInstagramHandle(handle)) return { outcome: "invalid", reason: "invalid" };
  return { outcome: "valid", handle };
}

/**
 * The display form of a normalised handle.
 *
 * The `@` is presentation only: it is never part of the stored identity.
 */
export function displayInstagramHandle(normalized: string): string {
  return normalized === "" ? "" : `@${normalized}`;
}

/**
 * Whether a user label is within the length the database accepts.
 *
 * A null label means "leave the label as it is"; this feature has no
 * convention for clearing a label, because the database has none either.
 */
export function isValidCompetitorLabel(label: string | null | undefined): boolean {
  if (label === null || label === undefined) return true;
  return label.length <= COMPETITOR_LABEL_MAX_LENGTH;
}
