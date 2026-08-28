export interface SocialAccount {
    id: string;
    platform: string;
    access_token: string;
    refresh_token: string | null;
    token_expires_at: string | null;
    platform_user_id: string;
    user_id: string;
}

export async function refreshFacebookToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number } | null> {
    // Facebook long-lived tokens last 60 days and can be refreshed
    // Exchange for a new long-lived token
    try {
        const response = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?` +
            `grant_type=fb_exchange_token&` +
            `client_id=${Deno.env.get('FACEBOOK_APP_ID')}&` +
            `client_secret=${Deno.env.get('FACEBOOK_APP_SECRET')}&` +
            `fb_exchange_token=${account.access_token}`
        );

        const data = await response.json();

    if (!response.ok || data.error || !data.access_token) {
            const errorMsg = data.error?.message || data.error?.error_user_msg || 'Facebook token refresh failed';
            console.error('Facebook token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 5184000 // 60 days default
        };
    } catch (error) {
        console.error('Error refreshing Facebook token:', error);
        return null;
    }
}

export async function refreshInstagramBusinessToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number } | null> {
    // Instagram Business Login tokens are Instagram-scoped: they refresh against
    // graph.instagram.com using the access token itself, not fb_exchange_token.
    try {
        const response = await fetch(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.access_token}`
        );

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const errorMsg = data.error?.message || data.error?.error_user_msg || 'Instagram token refresh failed';
            console.error('Instagram Business token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 5184000 // 60 days default
        };
    } catch (error) {
        console.error('Error refreshing Instagram Business token:', error);
        return null;
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

export async function refreshYouTubeToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number } | null> {
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
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 3600
        };
    } catch (error) {
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

export async function refreshThreadsToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number } | null> {
    // Threads uses long-lived tokens that can be refreshed
    try {
        const response = await fetch(
            `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${account.access_token}`
        );

        const data = await response.json();

        if (data.error || !response.ok || !data.access_token) {
            const errorMsg = data.error?.message || data.error?.error_user_msg || data.error || 'Threads token refresh failed';
            console.error('Threads token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 5184000 // 60 days default
        };
    } catch (error) {
        console.error('Error refreshing Threads token:', error);
        return null;
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
