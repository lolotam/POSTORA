import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  handleRestrictedCorsOptions,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { type AdminClient, createReviewLog, handleRequest } from "./handler.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
} | undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const admin = createClient(url, serviceRoleKey);
  const result = await handleRequest(req, {
    anonClient: (authorization) =>
      createClient(url, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    admin: admin as unknown as AdminClient,
    serviceRoleKey,
    supabaseUrl: url,
    fetch,
    now: Date.now,
    edgeRuntime: typeof EdgeRuntime !== "undefined" ? EdgeRuntime : undefined,
    log: createReviewLog(admin),
  }, () => req.json());
  return restrictedJsonResponse(req, result.body, result.status);
});
