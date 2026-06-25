// NOTE: Previously auto-generated; now maintained to read URLs from Vite env so
// it works against the self-hosted Supabase instance (https://api.postora.cloud).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('Missing VITE_SUPABASE_URL environment variable. Set it to your self-hosted Supabase URL (e.g. https://api.postora.cloud).');
}
if (!SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_SUPABASE_PUBLISHABLE_KEY environment variable.');
}

// Derive the storage key Supabase uses by default so we can purge any stale
// session that the auth server can no longer refresh (otherwise the GoTrue
// client retries indefinitely and emits 500 errors on every page load).
function deriveAuthStorageKey(url: string): string {
  try {
    const host = new URL(url).hostname;
    const ref = host.split('.')[0] || 'postora';
    return `sb-${ref}-auth-token`;
  } catch {
    return 'sb-postora-auth-token';
  }
}

const AUTH_STORAGE_KEY = deriveAuthStorageKey(SUPABASE_URL);

// Remove a persisted session whose refresh token is obviously unusable, so
// Supabase initializes as signed-out instead of looping refresh-token 500s.
function purgeStaleAuthSession(storageKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      refresh_token?: unknown;
      expires_at?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') {
      window.localStorage.removeItem(storageKey);
      return;
    }
    if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length < 10) {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Corrupt JSON — drop it so GoTrue does not retry forever.
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }
}

purgeStaleAuthSession(AUTH_STORAGE_KEY);

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    storageKey: AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
  }
});

// Listen once for refresh failures from GoTrue and clear the bad session so the
// loop stops within the same tab instead of waiting for the next reload.
if (typeof window !== 'undefined') {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') return;
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
      if (
        response.status >= 400 &&
        url.includes('/auth/v1/token') &&
        url.includes('grant_type=refresh_token')
      ) {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
    return response;
  };
}
