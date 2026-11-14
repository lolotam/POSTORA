import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  handleRestrictedCorsOptions,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import {
  type AdminClient,
  createRateLimiter,
  handleRequest,
} from "./handler.ts";

const rateLimit = createRateLimiter();
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(25_000)]);
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
  const result = await handleRequest(req, {
    anonClient: (authorization) =>
      createClient(url, anonKey, {
        global: { headers: { Authorization: authorization }, fetch: boundedFetch },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    // The narrow query port mirrors the Supabase chain without leaking SDK generics into tests.
    admin: createClient(url, serviceRoleKey, { global: { fetch: boundedFetch } }) as unknown as AdminClient,
    serviceRoleKey,
    fetch: boundedFetch,
    now: Date.now,
    rateLimit,
    log: (event) => console.log(JSON.stringify(event)),
  }, () => req.json());
  return restrictedJsonResponse(req, result.body, result.status);
});
