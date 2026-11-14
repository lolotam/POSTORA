import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bootstrapHandler } from "./handler.ts";

const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve((request) => bootstrapHandler(request, {
  rpc: (name, args, signal) => client.rpc(name, args).abortSignal(signal),
  apps: {
    facebook: { id: Deno.env.get("FACEBOOK_APP_ID") ?? "", secret: Deno.env.get("FACEBOOK_APP_SECRET") ?? "" },
    instagram: { id: Deno.env.get("INSTAGRAM_APP_ID") ?? "", secret: Deno.env.get("INSTAGRAM_APP_SECRET") ?? "" },
  },
}));
