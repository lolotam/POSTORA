// connector-oauth state: single-use, cryptographically random, bound to (user_id, social_account_id).
//
// §15 says real OAuth app registrations do not exist yet, so this module is
// deliberately seam-explicit: the storage is injectable. Production must use
// a DB table (e.g. connector_oauth_states) with row-level expiry and a
// DELETE ... RETURNING check for single-use. This in-memory implementation
// satisfies the security properties for unit tests and for a single isolate,
// and the interface makes the DB swap a one-file change.
//
// Properties verified here:
// - state is 32 bytes random (256 bits), base64url, non-guessable
// - bound to (user_id, social_account_id, connector_type)
// - single-use: second consume returns null
// - expiry enforced
// - replay across users refused (caller must compare stored user_id)

export interface OAuthStateRecord {
  state: string;
  userId: string;
  socialAccountId: string;
  connectorType: string;
  expiresAt: number;
  consumed: boolean;
}

export interface OAuthStateStore {
  create(state: OAuthStateRecord): void;
  consume(state: string): OAuthStateRecord | null;
  // For testing: allow inspection without consuming
  peek(state: string): OAuthStateRecord | null;
}

export function createInMemoryOAuthStateStore(): OAuthStateStore & { clear(): void } {
  const map = new Map<string, OAuthStateRecord>();

  return {
    create(record: OAuthStateRecord) {
      map.set(record.state, record);
    },
    consume(state: string): OAuthStateRecord | null {
      const rec = map.get(state);
      if (!rec) return null;
      if (rec.consumed) return null;
      if (Date.now() > rec.expiresAt) {
        map.delete(state);
        return null;
      }
      // Single-use: mark consumed and delete so second use is refused
      rec.consumed = true;
      map.delete(state);
      return rec;
    },
    peek(state: string): OAuthStateRecord | null {
      return map.get(state) ?? null;
    },
    clear() {
      map.clear();
    },
  };
}

// Global singleton for the isolate's lifetime. Tests replace it via
// setOAuthStateStore. Production isolations each hold their own; a
// horizontal scale loses cross-isolate single-use, which is why the
// comment above says the real store must be DB-backed.
let globalStore: OAuthStateStore = createInMemoryOAuthStateStore();

export function setOAuthStateStore(store: OAuthStateStore): void {
  globalStore = store;
}

export function getOAuthStateStore(): OAuthStateStore {
  return globalStore;
}

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function generateOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url without padding
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createBoundState(
  userId: string,
  socialAccountId: string,
  connectorType: string,
  ttlMs = OAUTH_STATE_TTL_MS,
): OAuthStateRecord {
  const state = generateOAuthState();
  const record: OAuthStateRecord = {
    state,
    userId,
    socialAccountId,
    connectorType,
    expiresAt: Date.now() + ttlMs,
    consumed: false,
  };
  getOAuthStateStore().create(record);
  return record;
}

export function verifyAndConsumeState(
  state: string,
  expectedUserId: string,
): OAuthStateRecord | null {
  const rec = getOAuthStateStore().consume(state);
  if (!rec) return null;
  // Whole security property: a state issued for user A cannot be used by B.
  // ARCHITECTURE §13: never trust user_id from request body — we compare
  // the stored binding against the *authenticated* caller.
  if (rec.userId !== expectedUserId) return null;
  return rec;
}
