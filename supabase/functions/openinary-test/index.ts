// Backs the "Test connection" button in Admin → Settings → CDN storage.
//
// The credentials under test live in the edge-function environment
// (OPENINARY_SERVER_URL / OPENINARY_API_KEY), not in app_settings, so the
// browser cannot verify them itself — hence this endpoint. It reports on the
// configuration the upload path will actually use, which is the only thing
// worth testing.
//
// Deliberately read-only: it lists a folder rather than round-tripping an
// upload, so an admin can click it freely without writing to the bucket.
// openinaryHealthCheck() covers the heavier behaviour-drift case.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { getOpeninaryConfig, listOpeninaryFolder } from "../_shared/openinary.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();

  let userId: string;
  try {
    ({ userId } = await authenticateCaller(req, null));
  } catch {
    return unauthorizedResponse();
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: adminRole } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!adminRole) return unauthorizedResponse("Admin access required");

  const config = getOpeninaryConfig();
  if (!config) {
    return jsonResponse({
      ok: false,
      reason: "not_configured",
      message: "OPENINARY_SERVER_URL and OPENINARY_API_KEY are not both set on the edge functions.",
    });
  }

  try {
    const files = await listOpeninaryFolder(config, config.folderPrefix);
    return jsonResponse({
      ok: true,
      serverUrl: config.serverUrl,
      folderPrefix: config.folderPrefix,
      fileCount: files.length,
      message: `Connected. ${files.length} file(s) under ${config.folderPrefix}.`,
    });
  } catch (e) {
    // Surface the reason (bad key, DNS, TLS, timeout) rather than a bare
    // failure, since telling those apart is the whole point of the button.
    return jsonResponse({
      ok: false,
      reason: "unreachable",
      serverUrl: config.serverUrl,
      message: e instanceof Error ? e.message : "Could not reach the Openinary server.",
    });
  }
});
