#!/usr/bin/env node
/**
 * Moves AI knowledge source files off public Cloudinary delivery and into the
 * private `ai-knowledge` bucket.
 *
 * Rows created before this migration hold a public Cloudinary URL in
 * `ai_knowledge_sources.file_path`. Anyone holding that link can read the file
 * — these are price lists, company profiles and internal templates — and the
 * path itself spells out the owner's email address. Uploads made since the
 * change write a `supabase://ai-knowledge/<user_id>/sources/<uuid>.<ext>`
 * reference instead; this script brings the older rows to the same shape.
 *
 * The readers dual-read both shapes, so a partially migrated table is fine and
 * the script is safe to re-run: rows already holding a storage reference are
 * skipped.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-knowledge-assets.mjs
 *     Dry run. Lists what would move and verifies each asset is fetchable.
 *
 *   ... node scripts/migrate-knowledge-assets.mjs --apply
 *     Copies each asset into the bucket, verifies the stored bytes byte-for-byte,
 *     then repoints the row. Leaves the Cloudinary original in place.
 *
 *   ... CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
 *       node scripts/migrate-knowledge-assets.mjs --apply --destroy
 *     Additionally destroys the Cloudinary original with `invalidate=true`, so
 *     the CDN drops its cached copy rather than serving it from the edge.
 *
 * Run --apply first and confirm every row reports `migrated`. Only then re-run
 * with --destroy: an asset destroyed before its copy is verified is gone.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const BUCKET = "ai-knowledge";
const CLOUDINARY_RAW_URL = /^https:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\/v\d+\/(.+)$/;

const apply = process.argv.includes("--apply");
const destroy = process.argv.includes("--destroy");

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
}

/** Mirrors cloudinaryFolderForEmail in supabase/functions/_shared/knowledgeSourceFiles.ts. */
function cloudinaryFolderForEmail(email) {
  return email
    .toLowerCase()
    .replace(/@/g, "_at_")
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

function objectPath(userId, fileName, objectId) {
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return `${userId}/sources/${objectId}${extension ? `.${extension}` : ""}`;
}

function sha256(buffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

async function cloudinaryDestroy(publicId) {
  const cloudName = required("CLOUDINARY_CLOUD_NAME");
  const apiKey = required("CLOUDINARY_API_KEY");
  const apiSecret = required("CLOUDINARY_API_SECRET");
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("sha1")
    .update(`invalidate=true&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest("hex");
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("invalidate", "true");
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, {
    method: "POST",
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  // "not found" means an earlier run already destroyed it — not a failure.
  if (body.result !== "ok" && body.result !== "not found") {
    throw new Error(`Cloudinary destroy returned ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function migrateOne(admin, source, emailByUser) {
  const email = emailByUser.get(source.user_id);
  if (!email) return { status: "skipped", reason: "owner email not found" };

  const publicId = decodeURIComponent(source.file_path.match(CLOUDINARY_RAW_URL)?.[1] ?? "");
  // Same scope rule the server applies: an asset outside the owner's folder is
  // not theirs to move, and silently relocating it would launder the problem.
  if (!publicId.startsWith(`media/${cloudinaryFolderForEmail(email)}/`)) {
    return { status: "skipped", reason: `asset outside owner folder: ${publicId || "unparseable"}` };
  }

  const response = await fetch(source.file_path);
  if (!response.ok) return { status: "failed", reason: `download ${response.status}` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);

  if (!apply) {
    return { status: "would-migrate", reason: `${bytes.length} bytes, sha256 ${digest.slice(0, 12)}` };
  }

  const path = objectPath(source.user_id, source.file_name, randomUUID());
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: response.headers.get("content-type") || "application/octet-stream",
  });
  if (uploadError) return { status: "failed", reason: `upload: ${uploadError.message}` };

  const { data: stored, error: readError } = await admin.storage.from(BUCKET).download(path);
  if (readError || !stored) {
    return { status: "failed", reason: `verify read: ${readError?.message ?? "no data"}` };
  }
  const storedDigest = sha256(await stored.arrayBuffer());
  if (storedDigest !== digest) {
    await admin.storage.from(BUCKET).remove([path]);
    return { status: "failed", reason: "stored bytes differ from the source" };
  }

  const { error: updateError } = await admin
    .from("ai_knowledge_sources")
    .update({ file_path: `supabase://${BUCKET}/${path}` })
    .eq("id", source.id);
  if (updateError) {
    await admin.storage.from(BUCKET).remove([path]);
    return { status: "failed", reason: `row update: ${updateError.message}` };
  }

  if (destroy) {
    const result = await cloudinaryDestroy(publicId);
    return { status: "migrated", reason: `${path} (cloudinary: ${result})` };
  }
  return { status: "migrated", reason: path };
}

async function main() {
  const admin = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  const { data: sources, error } = await admin
    .from("ai_knowledge_sources")
    .select("id, user_id, file_name, file_path")
    .like("file_path", "https://res.cloudinary.com/%")
    .order("id");
  if (error) throw error;

  if (!sources.length) {
    console.log("Nothing to migrate: no source still points at Cloudinary.");
    return;
  }

  const userIds = [...new Set(sources.map((s) => s.user_id))];
  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, email")
    .in("id", userIds);
  if (profileError) throw profileError;
  const emailByUser = new Map(profiles.map((p) => [p.id, p.email]));

  console.log(
    `${sources.length} source(s) across ${userIds.length} user(s)` +
      `${apply ? "" : " — dry run, pass --apply to move them"}\n`,
  );

  const tally = {};
  for (const source of sources) {
    let outcome;
    try {
      outcome = await migrateOne(admin, source, emailByUser);
    } catch (cause) {
      outcome = { status: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
    }
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    console.log(`${outcome.status.padEnd(13)} ${source.file_name ?? source.id} — ${outcome.reason}`);
  }

  console.log(`\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  if (tally.failed) process.exitCode = 1;
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
