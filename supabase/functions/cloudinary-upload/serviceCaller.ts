// The service-role fallback (used by n8n-api, which calls with the service key)
// accepts a userId from the body, so it must only open for the service key itself.
// Any other unparseable bearer would otherwise upload into an arbitrary user's library.

/** Constant-time comparison; a length mismatch returns false immediately. */
export function isServiceRoleBearer(token: string, serviceRoleKey: string | undefined): boolean {
  if (!token || !serviceRoleKey || token.length !== serviceRoleKey.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ serviceRoleKey.charCodeAt(i);
  return diff === 0;
}
