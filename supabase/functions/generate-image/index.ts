import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { serviceRoleCallerUserId } from "../_shared/auth-helper.ts";
import { handleGenerateImageRequest } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
serve((req) =>
  handleGenerateImageRequest(req, {
    admin: createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""),
    userClient: (authHeader) =>
      createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } } }),
    serviceRoleCallerUserId,
  }));
