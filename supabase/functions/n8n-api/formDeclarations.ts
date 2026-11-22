/**
 * Strict D3 declaration parsing at the public form ingress.
 *
 * The two YouTube declarations are answers to explicit Yes/No questions. A
 * field that is absent, empty, misspelled or carries a legacy truthy token is
 * NOT an answer: it stays a non-boolean value so no declaration proof can be
 * built from it. A lenient `truthy` parser here would manufacture a "No" for a
 * caller who never answered, which is exactly the legacy default D3 forbids.
 */

export const YOUTUBE_DECLARATION_FORM_KEYS = new Set([
  "youtube_made_for_kids",
  "youtube_contains_synthetic_media",
]);

export function parseExplicitDeclaration(value: string): boolean | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
