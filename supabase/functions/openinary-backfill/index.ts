// Mirrors already-stored Cloudinary objects into Openinary so the retirement
// gate in Admin → Settings → CDN storage can reach zero.
//
// Dual-writing only covers NEW uploads. Everything uploaded before Openinary
// was added to write_policy.providers exists on Cloudinary alone, and those
// rows are what the gate counts. This endpoint closes that gap.
//
// Safe to re-run and safe to interrupt. uploadToOpeninary() adopts an existing
// object when the path and byte count already match, so a retry re-verifies
// rather than re-uploading, and the unique constraint on
// (media_file_id, provider, object_version) makes the row write idempotent.
//
// Batched by design: it processes `limit` rows per call and reports how many
// remain, so the caller drives it in a loop instead of relying on one
// long-running request surviving to the end.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse } from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { getOpeninaryConfig, openinaryTarget, uploadToOpeninary } from "../_shared/openinary.ts";

const DEFAULT_BATCH = 15;
const MAX_BATCH = 100;
// Sequential by design. Every mirrored file streams the bytes down from
// Cloudinary and back up to Openinary, and adds an adopt-check listing on top,
// so a "small" batch is already several heavy requests per item. Running these
// in parallel earns a temporary lockout from the origin -- which it reports as
// 401, not 429 -- and the resulting backoff costs more wall-clock than it saves.
// Matches the sequential, 15-per-page shape the equivalent sync uses elsewhere.
const CONCURRENCY = 1;

// The lockout surfaces as 401 "Authentication required" on a key that is
// perfectly valid a minute later. Marking media failed for that would be a lie
// and would need a retry pass to undo, so a throttled batch stops early and
// leaves its rows untouched and still eligible.
const THROTTLE_PATTERN = /failed: (?:401|429)|authentication required|rate.?limit|too many requests/i;

type CloudinaryRow = {
  media_file_id: string;
  object_version: number;
  object_key: string;
  delivery_url: string | null;
};

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
    return jsonResponse({ error: "Openinary is not configured on the edge functions." }, 503);
  }

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Number(body.limit) || DEFAULT_BATCH, MAX_BATCH);

  const retryFailed = body.retry_failed === true;
  const { data: pending, error: selectError } = await db
    .rpc("get_openinary_backfill_batch", { p_limit: limit, p_retry_failed: retryFailed })
    .returns<CloudinaryRow[]>();
  if (selectError) return jsonResponse({ error: `Batch selection failed: ${selectError.message}` }, 500);

  const rows = pending ?? [];
  const failures: { media_file_id: string; error: string }[] = [];
  let succeeded = 0;
  let throttled = false;

  // A failed row is the durable retry record, matching how cloudinary-upload
  // treats a partial write. It is also what removes this media from the next
  // batch, so a write error here has to be reported rather than swallowed: with
  // no row written at all, the same media is selected again on every pass and
  // the caller's loop never reaches processed=0.
  async function recordFailure(row: CloudinaryRow, intendedKey: string, reason: string) {
    const { error } = await db.from("media_file_providers").upsert({
      media_file_id: row.media_file_id,
      provider: "openinary",
      object_version: row.object_version,
      object_key: intendedKey,
      status: "failed",
      error: reason,
    }, { onConflict: "media_file_id,provider,object_version" });
    if (error) {
      failures.push({
        media_file_id: row.media_file_id,
        error: `${reason} (and the failure row could not be written: ${error.message})`,
      });
    }
  }

  // Fixed-size worker pool over a shared cursor: keeps CONCURRENCY uploads in
  // flight without slicing the batch into chunks that stall on their slowest item.
  let cursor = 0;
  let attempted = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      attempted++;
      const target = openinaryTarget(row.object_key, config!.folderPrefix);
      const intendedKey = `${target.folder}/${target.baseName}`;

      if (!row.delivery_url) {
        failures.push({ media_file_id: row.media_file_id, error: "Cloudinary row has no delivery_url" });
        await recordFailure(row, intendedKey, "Cloudinary row has no delivery_url");
        continue;
      }

      // Extension is left to the source response rather than guessed from
      // media_files.mime_type: the stored object must match what Cloudinary
      // actually serves, or the delivery URL points at nothing.
      const result = await uploadToOpeninary(config!, row.delivery_url, target.folder, target.baseName);

      if (result.success && result.path) {
        const { error } = await db.from("media_file_providers").upsert({
          media_file_id: row.media_file_id,
          provider: "openinary",
          object_version: row.object_version,
          object_key: result.path,
          delivery_url: result.url,
          status: "ready",
          error: null,
        }, { onConflict: "media_file_id,provider,object_version" });
        if (error) {
          failures.push({ media_file_id: row.media_file_id, error: `Row write failed: ${error.message}` });
          continue;
        }
        succeeded++;
        continue;
      }

      const reason = result.error || "Upload failed";
      if (THROTTLE_PATTERN.test(reason)) {
        throttled = true;
        cursor = rows.length;
        return;
      }
      failures.push({ media_file_id: row.media_file_id, error: reason });
      await recordFailure(row, intendedKey, reason);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const { data: remaining } = await db.rpc("count_openinary_backfill_remaining");

  return jsonResponse({
    // Rows actually attempted, not rows selected: a throttled batch abandons
    // the rest, and reporting the selection would overstate the work done.
    processed: attempted,
    selected: rows.length,
    succeeded,
    failed: failures.length,
    // Truncated so one bad batch cannot return a multi-megabyte payload.
    errors: failures.slice(0, 10),
    remaining: remaining ?? null,
    throttled,
    done: rows.length === 0 && !throttled,
  });
});
