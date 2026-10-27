import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLogger } from "../_shared/logging.ts";
import {
  appSettingReadResult,
  configurationClientError,
  createAppSettingLookup,
  loadFacebookCredentialSettings,
  type FacebookCredentialMode,
} from "../_shared/facebookCredentialMode.ts";
import {
  CredentialStoreError,
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  createServiceRpcCaller,
  credentialReadClientError,
  type RpcCapableClient,
} from "../_shared/facebookUserCredentialStore.ts";
import {
  resolveProtectedUserToken,
  type ProtectedCredentialDeps,
} from "../_shared/protectedFacebookCredentials.ts";
import {
  getThreadsAccount,
  summarizeAccount,
  debugThreadsToken,
  classifyMetaError,
  isThreadsLocationSampleData,
  filterRelevantThreadsLocations,
} from "../_shared/threads-debug.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REQUEST_SOURCE = "threads-location-search";

/**
 * Where the Facebook Pages Search token comes from.
 *
 * Legacy mode keeps the browser-readable metadata copy and the Page token.
 * Protected mode uses the owner-scoped protected authority and nothing else:
 * a missing protected credential skips that account, and a failed protected
 * read is reported instead of being degraded into an empty result.
 */
interface FacebookPageSearchCredentials {
  mode: FacebookCredentialMode;
  resolve: (
    socialAccountId: string,
  ) => Promise<{ token: string } | { missing: true }>;
}

interface PlaceResult {
  id: string;
  name: string;
  address?: string;
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  source: "threads" | "facebook" | "nominatim";
  taggable_on_threads: boolean;
  eligibility_reason?: string;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, requestSource: REQUEST_SOURCE, ...body }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function structured(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: false, requestSource: REQUEST_SOURCE, ...body }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Facebook Pages Search fallback (returns real Meta Page IDs that Threads can tag) ───
async function searchFacebookPages(
  supabase: any,
  userId: string,
  query: string,
  credentials: FacebookPageSearchCredentials,
): Promise<PlaceResult[]> {
  // Find a usable Facebook or Instagram account with a token
  const { data: accounts, error: accountsError } = await supabase
    .from("social_accounts")
    .select("id, platform, access_token, account_metadata")
    .eq("user_id", userId)
    .in("platform", ["facebook", "instagram"])
    .eq("is_active", true)
    .order("connected_at", { ascending: false });

  if (accountsError) {
    console.error("[threads-location-search] account read failed", { event: "account_read_failed" });
    throw new CredentialStoreError("read_failed", "the account read failed");
  }

  if (!accounts || accounts.length === 0) return [];

  for (const acc of accounts) {
    const tokensToTry: string[] = [];
    if (credentials.mode === "protected") {
      const outcome = await credentials.resolve(acc.id);
      if ("missing" in outcome) continue;
      tokensToTry.push(outcome.token);
    } else {
      const userToken = acc.account_metadata?.user_token;
      tokensToTry.push(...(userToken ? [userToken, acc.access_token] : [acc.access_token]));
    }

    for (const token of tokensToTry) {
      if (!token) continue;
      try {
        const url = new URL("https://graph.facebook.com/v22.0/pages/search");
        url.searchParams.set("q", query);
        url.searchParams.set("fields", "id,name,location");
        url.searchParams.set("access_token", token);

        const res = await fetch(url.toString());
        const data = await res.json().catch(() => ({}));
        if (data?.error) {
          console.warn("[threads-location-search] FB pages/search err", {
            event: "provider_error",
            error_code: data.error.code ?? "unknown",
          });
          continue;
        }
        const rows = Array.isArray(data?.data) ? data.data.filter((p: any) => p.location) : [];
        if (rows.length > 0) {
          return rows.map((p: any) => ({
            id: String(p.id),
            name: p.name || "",
            city: p.location?.city || "",
            country: p.location?.country || "",
            latitude: p.location?.latitude ?? null,
            longitude: p.location?.longitude ?? null,
            source: "facebook" as const,
            taggable_on_threads: false,
            eligibility_reason: "facebook_reference_only",
          }));
        }
      } catch (e) {
        if (e instanceof CredentialStoreError) throw e;
        console.warn("[threads-location-search] FB fallback fetch failed", {
          event: "provider_fetch_failed",
        });
      }
    }
  }
  return [];
}

// ─── Nominatim fallback (last resort — produces non-tagable osm_ ids) ───
async function resolveFacebookPageSearchCredentials(
  client: RpcCapableClient,
  userId: string,
  mode: FacebookCredentialMode,
): Promise<FacebookPageSearchCredentials> {
  return {
    mode,
    resolve: async (socialAccountId: string) => {
      const rpc = createServiceRpcCaller(client);
      const deps: ProtectedCredentialDeps = {
        credentials: createFacebookUserCredentialStore(rpc),
        capabilities: createInstagramAccountCapabilityStore(rpc),
      };
      try {
        const resolved = await resolveProtectedUserToken(deps, {
          userId,
          socialAccountId,
        });
        return { token: resolved.token };
      } catch (error) {
        if (error instanceof CredentialStoreError) {
          const clientError = credentialReadClientError(error);
          if (error.code === "not_found" || error.code === "refused") return { missing: true };
          console.warn("[threads-location-search] protected credential unavailable", {
            event: clientError.error_code,
            account_id: socialAccountId,
          });
          throw error;
        }
        throw error;
      }
    },
  };
}

async function searchNominatim(query: string): Promise<PlaceResult[]> {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "10");
    url.searchParams.set("addressdetails", "1");
    const hasArabic = /[\u0600-\u06FF]/.test(query);
    url.searchParams.set("accept-language", hasArabic ? "ar" : "en");

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Postora/1.0 (contact: support@postora.cloud; https://postora.cloud)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((item: any) => ({
      id: `osm_${item.osm_type}_${item.osm_id}`,
      name: item.display_name?.split(",")[0] || item.name || "Unknown",
      city: item.address?.city || item.address?.town || item.address?.village || "",
      country: item.address?.country || "",
      latitude: item.lat ? Number(item.lat) : null,
      longitude: item.lon ? Number(item.lon) : null,
      source: "nominatim" as const,
      taggable_on_threads: false,
      eligibility_reason: "osm_reference_only",
    }));
  } catch (e) {
    console.warn(`[threads-location-search] Nominatim failed: ${(e as Error).message}`);
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const logger = createLogger(supabase, "threads-location-search", "edge");
  let userId: string | undefined;
  let query = "";

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");

    const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) throw new Error("Unauthorized");
    userId = claimsData.claims.sub as string;

    const body = await req.json();
    query = String(body?.query || "").trim();
    if (!query || query.length < 2) {
      return structured({ reason: "unknown", message: "Query must be at least 2 characters", results: [] });
    }

    const account = await getThreadsAccount(supabase, userId);
    // Server-controlled credential mode. Resolved before any protected-schema
    // access, so legacy mode never touches the protected authority.
    const { credentialMode } = await loadFacebookCredentialSettings(
      createAppSettingLookup(async (key) => {
        const { data, error } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
    );
    const facebookSearchCredentials = await resolveFacebookPageSearchCredentials(
      supabase,
      userId,
      credentialMode,
    );
    if (!account?.access_token) {
      // No Threads account — but we can still return FB Pages so the composer is useful
      const fbResults = await searchFacebookPages(supabase, userId, query, facebookSearchCredentials);
      if (fbResults.length > 0) {
        return ok({ results: fbResults, query, source: "facebook", fallback: true });
      }
      return structured({
        reason: "no_account",
        message: "No Threads account connected.",
        needsConnection: true,
        results: [],
      });
    }

    await logger.info("Threads location search — selected account", {
      event: "selected_account",
      platform: "threads",
      query,
      selected_account: summarizeAccount(account),
    }, userId);

    const preflight = await debugThreadsToken(account.access_token);
    let nativeResults: PlaceResult[] = [];
    let sampleDataDetected = false;

    if (preflight.ok) {
      const fields = "id,name,address,city,country,latitude,longitude";
      const apiUrl = `https://graph.threads.net/v1.0/location_search?q=${encodeURIComponent(query)}&fields=${fields}&access_token=${encodeURIComponent(account.access_token)}`;

      const res = await fetch(apiUrl);
      const data = await res.json().catch(() => ({}));

      await logger.info("Threads location search — live request", {
        event: "live_request",
        platform: "threads",
        query,
        endpoint: "/v1.0/location_search",
        meta_status: res.status,
        result_count: Array.isArray(data?.data) ? data.data.length : 0,
        error_code: data?.error?.code,
        error_message: data?.error?.message,
      }, userId);

      if (!data?.error) {
        const rawRows: any[] = Array.isArray(data?.data) ? data.data : [];
        if (isThreadsLocationSampleData(rawRows, query)) {
          sampleDataDetected = true;
          await logger.info("Threads location search — sample data detected", {
            event: "sample_data_detected",
            platform: "threads",
            query,
            result_count: rawRows.length,
          }, userId);
        } else {
          nativeResults = filterRelevantThreadsLocations(rawRows, query).map((p: any) => ({
            id: String(p.id),
            name: p.name || "",
            address: p.address || "",
            city: p.city || "",
            country: p.country || "",
            latitude: p.latitude ?? null,
            longitude: p.longitude ?? null,
            source: "threads" as const,
            taggable_on_threads: true,
          }));
        }
      }
    }

    // If Threads-native gave us real results, return them
    if (nativeResults.length > 0) {
      return ok({ results: nativeResults, query, source: "threads" });
    }

    // ─── Fallback 1: Facebook Pages Search (real Meta Page IDs — Threads can tag these) ───
    const fbResults = await searchFacebookPages(supabase, userId, query, facebookSearchCredentials);
    if (fbResults.length > 0) {
      await logger.info("Threads location search — facebook fallback used", {
        event: "facebook_fallback",
        platform: "threads",
        query,
        result_count: fbResults.length,
        sample_data_detected: sampleDataDetected,
      }, userId);
      return ok({
        results: fbResults,
        query,
        source: "facebook",
        sampleDataDetected,
        fallback: true,
      });
    }

    // ─── Fallback 2: Nominatim (reference only, not tagable) ───
    const osmResults = await searchNominatim(query);
    return ok({
      results: osmResults,
      query,
      source: "nominatim",
      sampleDataDetected,
      fallback: true,
      message: osmResults.length > 0
        ? "No taggable places found — showing reference results only."
        : "No locations found.",
    });
  } catch (error) {
    const config = configurationClientError(error);
    const credential = error instanceof CredentialStoreError ? credentialReadClientError(error) : null;
    const safe = config ?? credential;
    const message = safe?.error ?? "Location search failed.";
    const errorCode = safe?.error_code ?? "LOCATION_SEARCH_FAILED";
    await logger.error("Threads location search — internal error", {
      event: "internal_error",
      platform: "threads",
      query,
      error_code: errorCode,
    }, userId);
    return structured({
      reason: "unknown",
      message,
      error_code: errorCode,
      results: [],
    });
  }
});
