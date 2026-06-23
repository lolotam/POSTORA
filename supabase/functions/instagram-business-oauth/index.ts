/**
 * instagram-business-oauth
 * ------------------------
 * Dedicated endpoint for the "Connect Instagram via Facebook Business" flow.
 *
 * Status: PHASE 3 SCAFFOLD.
 *
 * The actual Facebook-Pages → Instagram-Business-Account discovery and token
 * exchange logic currently lives in `facebook-oauth`. To avoid duplicating
 * ~800 lines of carefully reviewed Pages/IG logic during this migration, this
 * endpoint forwards the authorize request to `facebook-oauth` and lets the
 * frontend hook fall back to the existing Facebook OAuth path. Once
 * `facebook-oauth` is split into a shared helper module, this function will
 * own the full lifecycle (init → callback → save → redirect to
 * https://postora.cloud/profiles?connected=instagram).
 *
 * Provider-console action: register
 *   https://api.postora.cloud/functions/v1/instagram-business-oauth
 * as a Valid OAuth Redirect URI on the Meta app ONLY after this function
 * implements the full callback lifecycle. Until then, the existing
 * facebook-oauth redirect URI continues to handle the callback.
 */

import { createOAuthState } from "../_shared/oauthState.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Callback from Meta -> not yet implemented here; redirect to canonical
  // facebook-oauth callback path which currently owns the logic.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const forward = new URL(`${SUPABASE_URL}/functions/v1/facebook-oauth`);
    url.searchParams.forEach((v, k) => forward.searchParams.set(k, v));
    return Response.redirect(forward.toString(), 302);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action !== "authorize") {
      return new Response(
        JSON.stringify({
          error: "unsupported_action",
          message: "instagram-business-oauth currently supports only action=authorize and delegates execution to facebook-oauth.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userId = body?.user_id as string | undefined;
    const profileId = (body?.social_profile_id as string | null | undefined) ?? null;
    const returnTo =
      (body?.return_to as string | undefined) ?? "https://postora.cloud/profiles";

    if (!userId) {
      return new Response(JSON.stringify({ error: "missing_user_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sign a unified-state payload so when this function gains its own
    // callback handler it can verify the round-trip without code changes.
    let _state: string | null = null;
    try {
      _state = await createOAuthState({
        platform: "instagram",
        flow: "facebook_business",
        user_id: userId,
        profile_id: profileId,
        return_to: returnTo,
      });
    } catch (err) {
      console.warn(
        "instagram-business-oauth: createOAuthState failed (OAUTH_STATE_SECRET likely unset); falling back to facebook-oauth signed state",
        err instanceof Error ? err.message : "unknown",
      );
    }

    // Delegate to facebook-oauth's authorize action — it already builds a
    // proper Meta OAuth URL with Pages + IG scopes and returns { url }.
    const fbResp = await fetch(`${SUPABASE_URL}/functions/v1/facebook-oauth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SUPABASE_ANON_KEY ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } : {}),
      },
      body: JSON.stringify({
        action: "authorize",
        user_id: userId,
        social_profile_id: profileId,
        return_to: returnTo,
        target_platform: "instagram",
      }),
    });

    const fbJson = await fbResp.json().catch(() => ({}));
    if (!fbResp.ok || !fbJson?.url) {
      return new Response(
        JSON.stringify({
          error: "facebook_oauth_delegation_failed",
          status: fbResp.status,
          detail: fbJson?.error ?? null,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ url: fbJson.url, delegated_to: "facebook-oauth", flow: "facebook_business" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("instagram-business-oauth error:", err);
    return new Response(
      JSON.stringify({
        error: "internal_error",
        message: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
