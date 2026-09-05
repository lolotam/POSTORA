import { type MetaRefreshOutcome, parseMetaError } from "./metaErrors.ts";

/** Provider calls must be bounded (ARCHITECTURE.md §26). The refresh loop is sequential
 *  and the edge worker dies at 60s, so one hang strands every account after it.
 *  8s, not 10s: with the 45s sweep budget in refresh-tokens, five consecutive worst-case
 *  hangs must still leave room to persist results. */
const META_FETCH_TIMEOUT_MS = 8_000;

export interface SocialAccount {
    id: string;
    platform: string;
    access_token: string;
    refresh_token: string | null;
    token_expires_at: string | null;
    platform_user_id: string;
    user_id: string;
}

export async function refreshFacebookToken(account: SocialAccount): Promise<MetaRefreshOutcome> {
    // POST, not a query string: Meta accepts the credential in the body, and keeping it
    // out of the URL means no logger, proxy or fetch error can ever capture it.
    try {
        const response = await fetch("https://graph.facebook.com/v18.0/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "fb_exchange_token",
                client_id: Deno.env.get("FACEBOOK_APP_ID") ?? "",
                client_secret: Deno.env.get("FACEBOOK_APP_SECRET") ?? "",
                fb_exchange_token: account.access_token,
            }),
            signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
        });

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const error = parseMetaError(response.status, data);
            console.error("[meta-refresh] facebook exchange failed", {
                type: error.type, code: error.code, error_subcode: error.error_subcode, message: error.message,
            });
            return { ok: false, error };
        }

        return { ok: true, access_token: data.access_token, expires_in: data.expires_in || 5184000 };
    } catch (error) {
        // Never log the error object: Deno puts the full request URL in network error
        // messages, and that URL would carry the token if it were ever moved back.
        const name = error instanceof Error ? error.name : "UnknownError";
        console.error(`[meta-refresh] facebook exchange threw: ${name}`);
        return { ok: false, error: { type: name, message: "network or timeout failure", transient: true } };
    }
}

export async function refreshInstagramBusinessToken(account: SocialAccount): Promise<MetaRefreshOutcome> {
    // Instagram Business Login tokens are Instagram-scoped: they refresh against
    // graph.instagram.com using the access token itself, not fb_exchange_token.
    // ⚠️ This endpoint REJECTS POST ("Unsupported post request") — verified with a real
    // token on 2026-08-29 — so it stays on GET and the credential stays in the URL.
    // The sanitized catch below is therefore load-bearing, not defence in depth.
    try {
        const response = await fetch(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.access_token}`,
            { signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) }
        );

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const error = parseMetaError(response.status, data);
            console.error("[meta-refresh] instagram exchange failed", {
                type: error.type, code: error.code, error_subcode: error.error_subcode, message: error.message,
            });
            return { ok: false, error };
        }

        return { ok: true, access_token: data.access_token, expires_in: data.expires_in || 5184000 };
    } catch (error) {
        // Deno embeds the full URL — access token included — in network error messages.
        // Log error.name only; logging the object leaks a live credential.
        const name = error instanceof Error ? error.name : "UnknownError";
        console.error(`[meta-refresh] instagram exchange threw: ${name}`);
        return { ok: false, error: { type: name, message: "network or timeout failure", transient: true } };
    }
}

export async function refreshTikTokToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for TikTok account');
        return null;
    }

    try {
        const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_key: Deno.env.get('TIKTOK_CLIENT_KEY') || '',
                client_secret: Deno.env.get('TIKTOK_CLIENT_SECRET') || '',
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
            }),
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            const errorMsg = data.error_description || data.error || 'TikTok token refresh failed';
            console.error('TikTok token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in || 86400
        };
    } catch (error) {
        console.error('Error refreshing TikTok token:', error);
        return null;
    }
}

export class YouTubeInvalidGrantError extends Error {
    constructor() {
        super('youtube_invalid_grant');
        this.name = 'YouTubeInvalidGrantError';
    }
}

export async function refreshYouTubeToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number; scope?: string } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for YouTube account');
        return null;
    }

    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
                client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
            }),
        });

        const data = await response.json();

        if (data.error) {
            const errorMsg = data.error_description || data.error;
            console.error('YouTube token refresh failed:', errorMsg);
            if (data.error === 'invalid_grant') throw new YouTubeInvalidGrantError();
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 3600,
            scope: typeof data.scope === 'string' ? data.scope : undefined
        };
    } catch (error) {
        if (error instanceof YouTubeInvalidGrantError) throw error;
        console.error('Error refreshing YouTube token:', error);
        return null;
    }
}

export async function refreshPinterestToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for Pinterest account');
        return null;
    }

    try {
        const clientId = Deno.env.get('PINTEREST_CLIENT_ID') || '';
        const clientSecret = Deno.env.get('PINTEREST_CLIENT_SECRET') || '';

        const response = await fetch('https://api.pinterest.com/v5/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
            }),
        });

        const data = await response.json();

        if (data.error || !response.ok) {
            const errorMsg = data.message || data.error_description || data.error || 'Pinterest token refresh failed';
            console.error('Pinterest token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || account.refresh_token,
            expires_in: data.expires_in || 2592000 // 30 days default
        };
    } catch (error) {
        console.error('Error refreshing Pinterest token:', error);
        return null;
    }
}

export async function refreshLinkedInToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for LinkedIn account');
        return null;
    }

    try {
        const clientId = Deno.env.get('LINKEDIN_CLIENT_ID') || '';
        const clientSecret = Deno.env.get('LINKEDIN_CLIENT_SECRET') || '';

        const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
                client_id: clientId,
                client_secret: clientSecret,
            }),
        });

        const data = await response.json();

        if (data.error || !response.ok) {
            const errorMsg = data.error_description || data.error || 'LinkedIn token refresh failed';
            console.error('LinkedIn token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || account.refresh_token,
            expires_in: data.expires_in || 5184000 // 60 days default
        };
    } catch (error) {
        console.error('Error refreshing LinkedIn token:', error);
        return null;
    }
}

export async function refreshTwitterToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for Twitter account');
        return null;
    }

    try {
        const clientId = Deno.env.get('TWITTER_CLIENT_ID') || '';
        const clientSecret = Deno.env.get('TWITTER_CLIENT_SECRET') || '';

        const response = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
            }),
        });

        const data = await response.json();

        if (data.error || !response.ok) {
            const errorMsg = data.error_description || data.error || 'Twitter token refresh failed';
            console.error('Twitter token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || account.refresh_token,
            expires_in: data.expires_in || 7200 // 2 hours default
        };
    } catch (error) {
        console.error('Error refreshing Twitter token:', error);
        return null;
    }
}

export async function refreshThreadsToken(account: SocialAccount): Promise<MetaRefreshOutcome> {
    // Threads uses long-lived tokens that can be refreshed. ⚠️ Stays on GET: POST support
    // is unproven (both methods answer the same threads_basic permission error), and a
    // blind migration would fail every refresh. The sanitized catch is load-bearing.
    try {
        const response = await fetch(
            `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${account.access_token}`,
            { signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) }
        );

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const error = parseMetaError(response.status, data);
            console.error("[meta-refresh] threads exchange failed", {
                type: error.type, code: error.code, error_subcode: error.error_subcode, message: error.message,
            });
            return { ok: false, error };
        }

        return { ok: true, access_token: data.access_token, expires_in: data.expires_in || 5184000 };
    } catch (error) {
        // Deno embeds the full URL — access token included — in network error messages.
        // Log error.name only; logging the object leaks a live credential.
        const name = error instanceof Error ? error.name : "UnknownError";
        console.error(`[meta-refresh] threads exchange threw: ${name}`);
        return { ok: false, error: { type: name, message: "network or timeout failure", transient: true } };
    }
}

export async function refreshBlueskyToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for Bluesky account');
        return null;
    }

    try {
        const response = await fetch('https://bsky.social/xrpc/com.atproto.server.refreshSession', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${account.refresh_token}`,
            },
        });

        const data = await response.json();

        if (data.error || !response.ok) {
            const errorMsg = data.message || data.error || 'Bluesky token refresh failed';
            console.error('Bluesky token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.accessJwt,
            refresh_token: data.refreshJwt,
            expires_in: 86400 // Bluesky tokens last ~24 hours
        };
    } catch (error) {
        console.error('Error refreshing Bluesky token:', error);
        return null;
    }
}

export async function refreshRedditToken(account: SocialAccount): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
    if (!account.refresh_token) {
        console.error('No refresh token available for Reddit account');
        return null;
    }

    try {
        const clientId = Deno.env.get('REDDIT_CLIENT_ID') || '';
        const clientSecret = Deno.env.get('REDDIT_CLIENT_SECRET') || '';
        const credentials = btoa(`${clientId}:${clientSecret}`);

        const response = await fetch('https://www.reddit.com/api/v1/access_token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Postora/1.0',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.refresh_token,
            }),
        });

        const data = await response.json();

        if (data.error || !response.ok) {
            const errorMsg = data.error_description || data.error || 'Reddit token refresh failed';
            console.error('Reddit token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || account.refresh_token,
            expires_in: data.expires_in || 3600 // 1 hour default
        };
    } catch (error) {
        console.error('Error refreshing Reddit token:', error);
        return null;
    }
}
