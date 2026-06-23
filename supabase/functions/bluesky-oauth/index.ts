import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { createLogger } from "../_shared/logging.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// AT Protocol OAuth configuration
const CLIENT_ID = "https://postora.cloud/client-metadata.json";
const BLUESKY_AUTH_SERVER = "https://bsky.social";

// Unified backend callback URL. Must match an entry in client-metadata.json.
const BLUESKY_REDIRECT_URI =
  Deno.env.get("BLUESKY_REDIRECT_URI") ??
  `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/bluesky-oauth`;
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

// Generate a random code verifier for PKCE
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// Generate code challenge from verifier
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Base64 URL encode
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Generate a DPoP key pair for token binding
async function generateDPoPKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );
}

// Export public key to JWK format
async function exportPublicKeyJWK(publicKey: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey("jwk", publicKey);
}

// Export private key to JWK format for storage
async function exportPrivateKeyJWK(privateKey: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey("jwk", privateKey);
}

// Import private key from JWK format
async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"]
  );
}

// Generate DPoP proof JWT
async function generateDPoPProof(
  privateKey: CryptoKey,
  publicKeyJWK: JsonWebKey,
  method: string,
  url: string,
  accessToken?: string,
  nonce?: string
): Promise<string> {
  const header = {
    alg: "ES256",
    typ: "dpop+jwt",
    jwk: {
      kty: publicKeyJWK.kty,
      crv: publicKeyJWK.crv,
      x: publicKeyJWK.x,
      y: publicKeyJWK.y,
    },
  };

  const payload: Record<string, string | number> = {
    jti: crypto.randomUUID(),
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  };

  // Include server-provided nonce for DPoP nonce binding (RFC 9449)
  if (nonce) {
    payload.nonce = nonce;
  }

  // Add access token hash if provided (for resource requests)
  if (accessToken) {
    const encoder = new TextEncoder();
    const data = encoder.encode(accessToken);
    const digest = await crypto.subtle.digest("SHA-256", data);
    payload.ath = base64UrlEncode(new Uint8Array(digest));
  }

  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  // Convert signature from DER to raw format (r || s)
  const signatureArray = new Uint8Array(signature);
  const encodedSignature = base64UrlEncode(signatureArray);

  return `${signingInput}.${encodedSignature}`;
}

// Resolve the user's PDS (Personal Data Server) from their handle
async function resolvePDS(handle: string): Promise<{ authServer: string; pds: string }> {
  const normalizedHandle = handle.includes(".") ? handle : `${handle}.bsky.social`;
  
  try {
    // Try to resolve the DID document
    const resolveResponse = await fetch(
      `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalizedHandle)}`
    );
    
    if (!resolveResponse.ok) {
      console.log("Could not resolve handle, using default PDS");
      return { authServer: BLUESKY_AUTH_SERVER, pds: "https://bsky.social" };
    }
    
    const { did } = await resolveResponse.json();
    
    // Get the DID document to find the PDS
    let didDoc;
    if (did.startsWith("did:plc:")) {
      const didDocResponse = await fetch(`https://plc.directory/${did}`);
      didDoc = await didDocResponse.json();
    } else if (did.startsWith("did:web:")) {
      const domain = did.replace("did:web:", "");
      const didDocResponse = await fetch(`https://${domain}/.well-known/did.json`);
      didDoc = await didDocResponse.json();
    }
    
    // Find PDS service endpoint
    const pdsService = didDoc?.service?.find(
      (s: { id: string; type: string }) => s.type === "AtprotoPersonalDataServer"
    );
    
    const pdsUrl = pdsService?.serviceEndpoint || "https://bsky.social";
    
    return { authServer: BLUESKY_AUTH_SERVER, pds: pdsUrl };
  } catch (error) {
    console.error("Error resolving PDS:", error);
    return { authServer: BLUESKY_AUTH_SERVER, pds: "https://bsky.social" };
  }
}

// Discover authorization server metadata
async function discoverAuthServer(authServer: string): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint?: string;
}> {
  try {
    const response = await fetch(`${authServer}/.well-known/oauth-authorization-server`);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("Error discovering auth server:", error);
  }
  
  // Fallback to default endpoints
  return {
    authorization_endpoint: `${authServer}/oauth/authorize`,
    token_endpoint: `${authServer}/oauth/token`,
    pushed_authorization_request_endpoint: `${authServer}/oauth/par`,
  };
}

interface CallbackResult {
  username: string;
  displayName?: string;
  userId: string;
  profileId: string | null;
  returnTo: string;
}

async function completeBlueskyCallback(
  supabase: ReturnType<typeof createClient>,
  logger: ReturnType<typeof createLogger>,
  code: string,
  state: string,
): Promise<CallbackResult> {
  let stateData: Record<string, unknown>;
  try {
    const stateJson = new TextDecoder().decode(
      Uint8Array.from(atob(state.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
    );
    stateData = JSON.parse(stateJson);
  } catch {
    throw new Error("Invalid state parameter");
  }

  const stateUserId = stateData.user_id as string;
  const stateProfileId = (stateData.social_profile_id as string | null | undefined) ?? null;
  const stateHandle = stateData.handle as string;
  const stateCodeVerifier = stateData.code_verifier as string;
  const stateDpopPrivateKey = stateData.dpop_private_key as JsonWebKey;
  const stateDpopPublicKey = stateData.dpop_public_key as JsonWebKey;
  const stateAuthServer = stateData.auth_server as string | undefined;
  const statePdsUrl = stateData.pds_url as string | undefined;
  const stateReturnTo = (stateData.return_to as string | undefined) ?? RETURN_URL_DEFAULT;

  const authServerMetadata = await discoverAuthServer(stateAuthServer || BLUESKY_AUTH_SERVER);
  const privateKey = await importPrivateKey(stateDpopPrivateKey);

  const dpopProof = await generateDPoPProof(
    privateKey,
    stateDpopPublicKey,
    "POST",
    authServerMetadata.token_endpoint,
  );

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: BLUESKY_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: stateCodeVerifier,
  });

  await logger.info("Exchanging code for tokens", { token_endpoint: authServerMetadata.token_endpoint, handle: stateHandle }, stateUserId);

  let tokenResponse = await fetch(authServerMetadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "DPoP": dpopProof },
    body: tokenParams.toString(),
  });
  let tokenData = await tokenResponse.json();

  if (tokenResponse.status === 400 && tokenData.error === "use_dpop_nonce") {
    const serverNonce = tokenResponse.headers.get("DPoP-Nonce");
    if (serverNonce) {
      const dpopProofWithNonce = await generateDPoPProof(
        privateKey, stateDpopPublicKey, "POST",
        authServerMetadata.token_endpoint, undefined, serverNonce,
      );
      tokenResponse = await fetch(authServerMetadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "DPoP": dpopProofWithNonce },
        body: tokenParams.toString(),
      });
      tokenData = await tokenResponse.json();
    }
  }

  if (!tokenResponse.ok || tokenData.error) {
    const errMsg = tokenData.error_description || tokenData.error || "Unknown error";
    await logger.error("Token exchange failed", { handle: stateHandle, error: errMsg, status: tokenResponse.status }, stateUserId);
    throw new Error(`Token exchange failed: ${errMsg}`);
  }

  const { access_token, refresh_token, sub: did } = tokenData;

  const profileDpopProof = await generateDPoPProof(
    privateKey, stateDpopPublicKey, "GET",
    `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`,
    access_token,
  );
  const profileResponse = await fetch(
    `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`,
    { headers: { Authorization: `DPoP ${access_token}`, "DPoP": profileDpopProof } },
  );
  const profileData = await profileResponse.json();
  const username = profileData.handle || stateHandle;
  const displayName = profileData.displayName;
  const avatarUrl = await cacheAvatarToCloudinary(profileData.avatar, stateUserId, "bluesky", did);

  const { error: dbError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id: stateUserId,
        platform: "bluesky",
        platform_user_id: did,
        platform_username: username,
        avatar_url: avatarUrl,
        access_token,
        refresh_token,
        is_active: true,
        social_profile_id: stateProfileId,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_metadata: {
          display_name: displayName,
          did,
          auth_method: "oauth",
          pds_url: statePdsUrl || "https://bsky.social",
          auth_server: stateAuthServer || "https://bsky.social",
          dpop_private_key: stateDpopPrivateKey,
          dpop_public_key: stateDpopPublicKey,
        },
        needs_reauth: false,
        failure_count: 0,
        last_refresh_error: null,
      },
      { onConflict: "user_id,platform,platform_user_id" },
    );
  if (dbError) {
    await logger.error("Failed to save Bluesky OAuth account", { handle: username, error: dbError.message }, stateUserId);
    throw new Error("Failed to save Bluesky account");
  }
  await logger.info("Bluesky OAuth account connected successfully", { handle: username, did, auth_method: "oauth" }, stateUserId);

  return { username, displayName, userId: stateUserId, profileId: stateProfileId, returnTo: stateReturnTo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Provider callback: GET /functions/v1/bluesky-oauth?code=...&state=...
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const logger = createLogger(supabase, "bluesky-oauth", "auth");

    if (oauthError) {
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "bluesky");
      ret.searchParams.set("error", oauthError);
      return Response.redirect(ret.toString(), 302);
    }
    if (!code || !state) {
      return new Response("Missing code/state", { status: 400 });
    }

    try {
      const result = await completeBlueskyCallback(supabase, logger, code, state);
      const ret = new URL(result.returnTo);
      ret.searchParams.set("connected", "bluesky");
      if (result.profileId) ret.searchParams.set("profile_id", result.profileId);
      return Response.redirect(ret.toString(), 302);
    } catch (err) {
      console.error("Bluesky GET callback error:", err);
      const ret = new URL(RETURN_URL_DEFAULT);
      ret.searchParams.set("connected", "bluesky");
      ret.searchParams.set("error", "bluesky_callback_failed");
      return Response.redirect(ret.toString(), 302);
    }
  }



  try {
    const body = await req.json();
    const { action, handle, app_password, social_profile_id, code, state, return_to } = body;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const logger = createLogger(supabase, 'bluesky-oauth', 'auth');
    // Authenticate caller for actions that modify user data
    let user_id: string | undefined;
    if (["authorize", "connect"].includes(action)) {
      const auth = await authenticateCaller(req, body.user_id);
      user_id = auth.userId;
    } else {
      user_id = body.user_id; // callback uses state-embedded user_id
    }

    // ============= OAUTH AUTHORIZE =============
    if (action === "authorize") {
      console.log("Starting Bluesky OAuth flow for handle:", handle);

      if (!handle) {
        throw new Error("Handle is required for OAuth");
      }

      const normalizedHandle = handle.includes(".") ? handle : `${handle}.bsky.social`;
      
      // Resolve PDS and auth server
      const { authServer, pds: resolvedPds } = await resolvePDS(normalizedHandle);
      const authServerMetadata = await discoverAuthServer(authServer);
      
      // Generate PKCE code verifier and challenge
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      
      // Generate DPoP key pair
      const keyPair = await generateDPoPKeyPair();
      const publicKeyJWK = await exportPublicKeyJWK(keyPair.publicKey);
      const privateKeyJWK = await exportPrivateKeyJWK(keyPair.privateKey);
      
      // Create state parameter
      const stateData = {
        user_id,
        social_profile_id,
        handle: normalizedHandle,
        code_verifier: codeVerifier,
        dpop_private_key: privateKeyJWK,
        dpop_public_key: publicKeyJWK,
        auth_server: authServer,
        pds_url: resolvedPds,
        nonce: crypto.randomUUID(),
      };
      
      const stateParam = base64UrlEncode(new TextEncoder().encode(JSON.stringify(stateData)));
      
      // Build authorization URL
      const authParams = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: redirect_uri || "https://postora.cloud/profiles",
        scope: "atproto transition:generic",
        state: stateParam,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        login_hint: normalizedHandle,
      });

      // Check if PAR is available
      if (authServerMetadata.pushed_authorization_request_endpoint) {
        // Use Pushed Authorization Request (PAR) for better security
        console.log("Using PAR endpoint:", authServerMetadata.pushed_authorization_request_endpoint);
        
        const dpopProof = await generateDPoPProof(
          keyPair.privateKey,
          publicKeyJWK,
          "POST",
          authServerMetadata.pushed_authorization_request_endpoint
        );
        
        let parResponse = await fetch(authServerMetadata.pushed_authorization_request_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "DPoP": dpopProof,
          },
          body: authParams.toString(),
        });
        
        // DPoP Nonce Retry for PAR
        if (parResponse.status === 400) {
          const parErrorData = await parResponse.json().catch(() => ({}));
          if (parErrorData.error === "use_dpop_nonce") {
            const serverNonce = parResponse.headers.get("DPoP-Nonce");
            if (serverNonce) {
              console.log("PAR: server requires DPoP nonce, retrying...");
              const dpopProofWithNonce = await generateDPoPProof(
                keyPair.privateKey, publicKeyJWK, "POST",
                authServerMetadata.pushed_authorization_request_endpoint!, undefined, serverNonce
              );
              parResponse = await fetch(authServerMetadata.pushed_authorization_request_endpoint!, {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "DPoP": dpopProofWithNonce,
                },
                body: authParams.toString(),
              });
            }
          }
        }

        if (parResponse.ok) {
          const parData = await parResponse.json();
          const authUrl = `${authServerMetadata.authorization_endpoint}?request_uri=${encodeURIComponent(parData.request_uri)}&client_id=${encodeURIComponent(CLIENT_ID)}`;
          
          console.log("PAR successful, redirecting to:", authUrl);
          await logger.info("Bluesky OAuth PAR successful", { handle: normalizedHandle }, user_id);
          
          return new Response(JSON.stringify({ 
            success: true, 
            url: authUrl,
            state: stateParam,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        console.log("PAR failed, falling back to direct authorization");
      }
      
      // Direct authorization (fallback)
      const authUrl = `${authServerMetadata.authorization_endpoint}?${authParams.toString()}`;
      
      console.log("Redirecting to authorization URL:", authUrl);

      return new Response(JSON.stringify({ 
        success: true, 
        url: authUrl,
        state: stateParam,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============= OAUTH CALLBACK =============
    if (action === "callback") {
      console.log("Processing Bluesky OAuth callback");

      if (!code || !state) {
        throw new Error("Code and state are required for callback");
      }

      // Decode state parameter
      let stateData;
      try {
        const stateJson = new TextDecoder().decode(
          Uint8Array.from(atob(state.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
        );
        stateData = JSON.parse(stateJson);
      } catch (e) {
        throw new Error("Invalid state parameter");
      }

      const { 
        user_id: stateUserId, 
        social_profile_id: stateProfileId, 
        handle: stateHandle,
        code_verifier: stateCodeVerifier,
        dpop_private_key: stateDpopPrivateKey,
        dpop_public_key: stateDpopPublicKey,
        auth_server: stateAuthServer,
        pds_url: statePdsUrl,
      } = stateData;

      // Discover token endpoint
      const authServerMetadata = await discoverAuthServer(stateAuthServer || BLUESKY_AUTH_SERVER);
      
      // Import the private key
      const privateKey = await importPrivateKey(stateDpopPrivateKey);
      
      // Generate DPoP proof for token request
      const dpopProof = await generateDPoPProof(
        privateKey,
        stateDpopPublicKey,
        "POST",
        authServerMetadata.token_endpoint
      );

      // Exchange code for tokens
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect_uri || "https://postora.cloud/profiles",
        client_id: CLIENT_ID,
        code_verifier: stateCodeVerifier,
      });

      await logger.info("Exchanging code for tokens", { token_endpoint: authServerMetadata.token_endpoint, handle: stateHandle }, stateUserId);

      let tokenResponse = await fetch(authServerMetadata.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "DPoP": dpopProof,
        },
        body: tokenParams.toString(),
      });

      let tokenData = await tokenResponse.json();
      console.log("Token response status:", tokenResponse.status);

      // DPoP Nonce Retry (RFC 9449): if server requires nonce, retry with it
      if (tokenResponse.status === 400 && tokenData.error === "use_dpop_nonce") {
        const serverNonce = tokenResponse.headers.get("DPoP-Nonce");
        if (serverNonce) {
          console.log("Server requires DPoP nonce, retrying with nonce...");
          await logger.info("DPoP nonce required, retrying token exchange", { handle: stateHandle }, stateUserId);

          const dpopProofWithNonce = await generateDPoPProof(
            privateKey,
            stateDpopPublicKey,
            "POST",
            authServerMetadata.token_endpoint,
            undefined,
            serverNonce
          );

          tokenResponse = await fetch(authServerMetadata.token_endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "DPoP": dpopProofWithNonce,
            },
            body: tokenParams.toString(),
          });

          tokenData = await tokenResponse.json();
          console.log("Token response after nonce retry:", tokenResponse.status);
        }
      }

      if (!tokenResponse.ok || tokenData.error) {
        const errMsg = tokenData.error_description || tokenData.error || "Unknown error";
        await logger.error("Token exchange failed", { handle: stateHandle, error: errMsg, status: tokenResponse.status }, stateUserId);
        throw new Error(`Token exchange failed: ${errMsg}`);
      }

      const { access_token, refresh_token, sub: did } = tokenData;

      // Get user profile using DPoP-bound access token
      const profileDpopProof = await generateDPoPProof(
        privateKey,
        stateDpopPublicKey,
        "GET",
        `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`,
        access_token
      );

      const profileResponse = await fetch(
        `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`,
        {
          headers: { 
            Authorization: `DPoP ${access_token}`,
            "DPoP": profileDpopProof,
          },
        }
      );
      
      const profileData = await profileResponse.json();
      console.log("Profile fetched:", profileData.handle);

      const username = profileData.handle || stateHandle;
      const rawAvatarUrl = profileData.avatar;
      const displayName = profileData.displayName;

      // Cache avatar to Cloudinary for permanent storage
      const avatarUrl = await cacheAvatarToCloudinary(rawAvatarUrl, stateUserId, "bluesky", did);

      // Atomic upsert - prevents race conditions and ensures only 1 row per user/platform/account
      const { error: dbError } = await supabase
        .from("social_accounts")
        .upsert(
          {
            user_id: stateUserId,
            platform: "bluesky",
            platform_user_id: did,
            platform_username: username,
            avatar_url: avatarUrl,
            access_token,
            refresh_token,
            is_active: true,
            social_profile_id: stateProfileId,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            account_metadata: { 
              display_name: displayName, 
              did,
              auth_method: "oauth",
              pds_url: statePdsUrl || "https://bsky.social",
              auth_server: stateAuthServer || "https://bsky.social",
              dpop_private_key: stateDpopPrivateKey,
              dpop_public_key: stateDpopPublicKey,
            },
            // Reset health tracking on successful reconnection
            needs_reauth: false,
            failure_count: 0,
            last_refresh_error: null,
          },
          {
            onConflict: "user_id,platform,platform_user_id",
          }
        );

      if (dbError) {
        console.error("Database error:", dbError);
        await logger.error("Failed to save Bluesky OAuth account", { handle: username, error: dbError.message }, stateUserId);
        throw new Error("Failed to save Bluesky account");
      }

      await logger.info("Bluesky OAuth account connected successfully", { handle: username, did, auth_method: "oauth" }, stateUserId);

      return new Response(JSON.stringify({ success: true, username, displayName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============= APP PASSWORD CONNECT (Legacy) =============
    if (action === "connect") {
      console.log("Connecting Bluesky account via app password for handle:", handle);

      if (!handle || !app_password) {
        throw new Error("Handle and app password are required");
      }

      // Normalize handle (add .bsky.social if no domain)
      const normalizedHandle = handle.includes(".") ? handle : `${handle}.bsky.social`;

      // Create a session with Bluesky
      const sessionResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: normalizedHandle,
          password: app_password,
        }),
      });

      const sessionData = await sessionResponse.json();
      console.log("Bluesky session response:", JSON.stringify(sessionData).slice(0, 200));

      if (sessionData.error) {
        throw new Error(`Bluesky authentication failed: ${sessionData.message || sessionData.error}`);
      }

      const { did, accessJwt, refreshJwt } = sessionData;

      // Get user profile
      const profileResponse = await fetch(
        `https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`,
        {
          headers: { Authorization: `Bearer ${accessJwt}` },
        }
      );
      const profileData = await profileResponse.json();
      console.log("Bluesky profile:", JSON.stringify(profileData).slice(0, 200));

      const username = profileData.handle || normalizedHandle;
      const rawAvatarUrl = profileData.avatar;
      const displayName = profileData.displayName;

      // Cache avatar to Cloudinary for permanent storage
      const avatarUrl = await cacheAvatarToCloudinary(rawAvatarUrl, user_id, "bluesky", did);

      // Atomic upsert - prevents race conditions and ensures only 1 row per user/platform/account
      const { error: dbError } = await supabase
        .from("social_accounts")
        .upsert(
          {
            user_id,
            platform: "bluesky",
            platform_user_id: did,
            platform_username: username,
            avatar_url: avatarUrl,
            access_token: accessJwt,
            refresh_token: refreshJwt,
            is_active: true,
            social_profile_id,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            account_metadata: { display_name: displayName, did, auth_method: "app_password" },
            // Reset health tracking on successful reconnection
            needs_reauth: false,
            failure_count: 0,
            last_refresh_error: null,
          },
          {
            onConflict: "user_id,platform,platform_user_id",
          }
        );

      if (dbError) {
        console.error("Database error:", dbError);
        await logger.error("Failed to save Bluesky app password account", { handle, error: dbError.message }, user_id);
        throw new Error("Failed to save Bluesky account");
      }

      await logger.info("Bluesky app password account connected successfully", { handle: username, did, auth_method: "app_password" }, user_id);

      return new Response(JSON.stringify({ success: true, username, displayName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============= REFRESH TOKEN =============
    if (action === "refresh") {
      const { refresh_token: refreshToken, dpop_private_key: dpopPrivateKey, dpop_public_key: dpopPublicKey, account_id } = body;
      
      // Check if this is an OAuth account (has DPoP keys)
      if (dpopPrivateKey && dpopPublicKey) {
        console.log("Refreshing OAuth Bluesky token with DPoP");
        
        const authServerMetadata = await discoverAuthServer(BLUESKY_AUTH_SERVER);
        const privateKey = await importPrivateKey(dpopPrivateKey);
        
        const dpopProof = await generateDPoPProof(
          privateKey,
          dpopPublicKey,
          "POST",
          authServerMetadata.token_endpoint
        );
        
        const refreshParams = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        });
        
        let refreshResponse = await fetch(authServerMetadata.token_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "DPoP": dpopProof,
          },
          body: refreshParams.toString(),
        });
        
        let refreshData = await refreshResponse.json();
        
        // DPoP Nonce Retry for refresh
        if (refreshResponse.status === 400 && refreshData.error === "use_dpop_nonce") {
          const serverNonce = refreshResponse.headers.get("DPoP-Nonce");
          if (serverNonce) {
            console.log("Refresh: server requires DPoP nonce, retrying...");
            const dpopProofWithNonce = await generateDPoPProof(privateKey, dpopPublicKey, "POST", authServerMetadata.token_endpoint, undefined, serverNonce);
            refreshResponse = await fetch(authServerMetadata.token_endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "DPoP": dpopProofWithNonce,
              },
              body: refreshParams.toString(),
            });
            refreshData = await refreshResponse.json();
          }
        }

        if (!refreshResponse.ok || refreshData.error) {
          await logger.error("Failed to refresh Bluesky OAuth token", { error: refreshData.error_description || refreshData.error, account_id }, user_id);
          throw new Error(`Failed to refresh OAuth token: ${refreshData.error_description || refreshData.error}`);
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          access_token: refreshData.access_token,
          refresh_token: refreshData.refresh_token,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      // Legacy app password refresh
      console.log("Refreshing app password Bluesky session");
      
      const refreshResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.refreshSession", {
        method: "POST",
        headers: { Authorization: `Bearer ${refreshToken}` },
      });

      const refreshData = await refreshResponse.json();
      
      if (refreshData.error) {
        throw new Error(`Failed to refresh Bluesky session: ${refreshData.message}`);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        access_token: refreshData.accessJwt,
        refresh_token: refreshData.refreshJwt,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET LISTS - Fetch user's lists for reply controls
    // ─────────────────────────────────────────────────────────────────────────
    if (action === "get_lists") {
      const accountId = body.account_id;
      
      if (!accountId) {
        return new Response(JSON.stringify({ error: "account_id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      console.log("Fetching Bluesky lists for account:", accountId);
      
      // Get the account details
      const { data: account, error: accountError } = await supabase
        .from("social_accounts")
        .select("access_token, platform_user_id, account_metadata")
        .eq("id", accountId)
        .eq("platform", "bluesky")
        .single();
        
      if (accountError || !account) {
        return new Response(JSON.stringify({ error: "Bluesky account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      const accessToken = account.access_token;
      const did = account.platform_user_id;
      
      // Check if this is OAuth (has dpop_private_key) or app password auth
      const metadata = account.account_metadata as Record<string, unknown> | null;
      const isOAuth = metadata?.dpop_private_key;
      
      let headers: Record<string, string>;
      
      if (isOAuth && metadata?.dpop_private_key) {
        // OAuth - need DPoP proof
        const dpopJwk = metadata.dpop_private_key as JsonWebKey;
        const privateKey = await importPrivateKey(dpopJwk);
        const listsUrl = `https://bsky.social/xrpc/app.bsky.graph.getLists?actor=${encodeURIComponent(did)}`;
        const dpopProof = await generateDPoPProof(privateKey, dpopJwk, "GET", listsUrl, accessToken);
        headers = {
          "Authorization": `DPoP ${accessToken}`,
          "DPoP": dpopProof,
        };
      } else {
        // App password auth
        headers = {
          "Authorization": `Bearer ${accessToken}`,
        };
      }
      
      const listsResponse = await fetch(
        `https://bsky.social/xrpc/app.bsky.graph.getLists?actor=${encodeURIComponent(did)}`,
        { method: "GET", headers }
      );
      
      if (!listsResponse.ok) {
        const errorText = await listsResponse.text();
        console.error("Failed to fetch lists:", errorText);
        return new Response(JSON.stringify({ error: "Failed to fetch lists from Bluesky" }), {
          status: listsResponse.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      const listsData = await listsResponse.json();
      
      // Transform the lists to a simpler format
      const lists = (listsData.lists || []).map((list: {
        uri: string;
        name: string;
        purpose: string;
        avatar?: string;
        listItemCount?: number;
      }) => ({
        uri: list.uri,
        name: list.name,
        purpose: list.purpose,
        avatar: list.avatar,
        listItemCount: list.listItemCount || 0,
      }));
      
      console.log(`Found ${lists.length} lists for Bluesky account`);
      
      return new Response(JSON.stringify({ lists }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    console.error("Bluesky OAuth error:", error);
    // Log to admin dashboard with full details
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const errorLogger = createLogger(supabase, 'bluesky-oauth', 'auth');
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      await errorLogger.error("Bluesky OAuth error", { 
        error: errorMessage, 
        stack: errorStack,
        platform: "bluesky",
      });
    } catch (_) { /* don't let logging failure mask original error */ }
    
    return new Response(
      JSON.stringify({ error: "Authentication failed. Please try again." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
