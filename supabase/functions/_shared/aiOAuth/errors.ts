export type AiOAuthErrorCode =
  | 'not_connected'
  | 'reauth_required'
  | 'refresh_failed'
  | 'refresh_timeout'
  | 'oauth_disabled'
  | 'invalid_state'
  | 'invalid_code'
  | 'exchange_failed'
  | 'oauth_unsupported_provider';

/**
 * Typed error for the admin AI subscription OAuth flow. The `code` is stable
 * and safe to return to the admin UI; the message must never carry a token.
 */
export class AiOAuthError extends Error {
  constructor(readonly code: AiOAuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AiOAuthError';
  }
}

/** Local storage was unavailable; this says nothing about the provider credential. */
export class AiOAuthStorageError extends AiOAuthError {
  constructor() {
    super('refresh_failed', 'The stored subscription credential could not be read.');
    this.name = 'AiOAuthStorageError';
  }
}
