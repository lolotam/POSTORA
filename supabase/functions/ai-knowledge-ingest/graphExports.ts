/* eslint-disable @typescript-eslint/no-explicit-any */
// Building and publishing a user's knowledge-graph export.
//
// Moved verbatim out of ai-knowledge-ingest/index.ts, where these were
// function-local and therefore unreachable from any other edge function. The
// nightly refresh worker needs exactly this, so they live in their own module
// and index.ts imports them back. Behaviour is unchanged; the only edit is
// index.ts's local BUCKET becoming the shared KNOWLEDGE_BUCKET, which is the
// same string.

import JSZip from "npm:jszip@3.10.1";
import {
  buildGraphHtml,
  buildObsidianNotes,
  type ExportEntity,
  type ExportRelation,
} from "./exports.ts";
import {
  deleteFromOpeninary,
  getOpeninaryConfig,
  openinaryDeliveryUrl,
} from "../_shared/openinary.ts";
import {
  cloudinaryFolderForEmail,
  KNOWLEDGE_BUCKET,
} from "../_shared/knowledgeSourceFiles.ts";
import { STORAGE_REF_SCHEME } from "../_shared/knowledgeExportUrls.ts";
import { cloudinarySignature } from "../_shared/cloudinarySignature.ts";

type AdminClient = any;

export async function uploadGraphExport(
  admin: AdminClient,
  contents: Uint8Array | string,
  fileName: string,
  contentType: string,
  userEmail: string,
): Promise<string> {
  const folder = `media/${cloudinaryFolderForEmail(userEmail)}/knowledge-graph`;
  const body = typeof contents === "string"
    ? contents
    : (new Uint8Array(contents).buffer as ArrayBuffer);

  const openinaryConfig = getOpeninaryConfig();
  if (openinaryConfig) {
    const targetFolder = `${openinaryConfig.folderPrefix}/${folder}`;
    const requestedPath = `${targetFolder}/${fileName}`;
    try {
      // The Cloudinary path below uploads with overwrite=true; Openinary suffixes collisions
      // instead, so the previous export has to be removed or each regeneration leaks another copy.
      await deleteFromOpeninary(openinaryConfig, requestedPath);
      const form = new FormData();
      form.append("folder", targetFolder);
      form.append("files", new File([body], fileName, { type: contentType }));
      const res = await fetch(`${openinaryConfig.serverUrl}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${openinaryConfig.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const payload = await res.json().catch(() => null);
      const stored = payload?.files?.[0]?.path;
      // COLLISION-AS-FAILURE, as in _shared/openinary.ts: a suffixed path is not the URL the
      // exports row will hand back, so treat any rename as a failed upload.
      if (res.ok && payload?.success && stored === requestedPath) {
        return openinaryDeliveryUrl(openinaryConfig, stored);
      }
      // Openinary enforces a media MIME allow-list, so text/html and application/zip may be
      // rejected outright. Log it.
      console.warn(
        `[uploadGraphExport] Openinary did not store ${fileName} (HTTP ${res.status}): ${payload?.error ?? stored ?? "no stored path"} — trying self-hosted Supabase storage`,
      );
    } catch (err) {
      console.warn("[uploadGraphExport] Openinary upload failed, trying self-hosted Supabase storage:", err);
    }
  }

  // Self-hosted Supabase Storage (primary fallback for raw/zip/html files)
  try {
    const storagePath = `${folder}/${fileName}`;
    const { error: storageError } = await (admin as any).storage
      .from(KNOWLEDGE_BUCKET)
      .upload(storagePath, body, {
        contentType,
        upsert: true,
      });
    if (!storageError) {
      // Store a durable backend reference, not a URL: the bucket is private
      // (a public /object/public/ URL would bypass owner checks and is being
      // removed), and a pre-signed URL would expire in the row. The owner gets
      // a short-TTL signed URL from the resolve_export_urls action.
      return `${STORAGE_REF_SCHEME}${KNOWLEDGE_BUCKET}/${storagePath.replace(/^\/+/, "")}`;
    } else {
      console.warn(`[uploadGraphExport] Supabase storage upload error for ${storagePath}:`, storageError);
    }
  } catch (err) {
    console.warn("[uploadGraphExport] Supabase storage upload failed, trying Cloudinary fallback:", err);
  }

  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (cloudName && apiKey && apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await cloudinarySignature(
      `folder=${folder}&overwrite=true&public_id=${fileName}&timestamp=${timestamp}${apiSecret}`,
    );
    const form = new FormData();
    form.append("file", new Blob([body], { type: contentType }), fileName);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    form.append("folder", folder);
    form.append("public_id", fileName);
    form.append("overwrite", "true");
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json();
    if (response.ok && payload.secure_url) return payload.secure_url;
  }

  throw new Error("Storage provider not configured (Openinary, Supabase Storage, or Cloudinary required)");
}

export async function createGraphExports(admin: AdminClient, userId: string, userEmail: string) {
  const [{ data: entities, error: entityError }, { data: relations, error: relationError }] = await Promise.all([
    (admin as any).from("ai_knowledge_entities").select("id, name, type, description").eq("user_id", userId),
    (admin as any)
      .from("ai_knowledge_relations")
      .select("source_entity_id, target_entity_id, relation")
      .eq("user_id", userId),
  ]);
  if (entityError || relationError) throw entityError || relationError;
  const graphEntities = (entities || []) as ExportEntity[];
  const graphRelations = (relations || []) as ExportRelation[];
  const zip = new JSZip();
  for (const [name, note] of buildObsidianNotes(graphEntities, graphRelations)) zip.file(name, note);
  const [htmlUrl, vaultUrl] = await Promise.all([
    uploadGraphExport(admin, buildGraphHtml(graphEntities, graphRelations), "graph.html", "text/html", userEmail),
    uploadGraphExport(
      admin,
      await zip.generateAsync({ type: "uint8array" }),
      "obsidian-vault.zip",
      "application/zip",
      userEmail,
    ),
  ]);
  const { error } = await (admin as any).from("ai_knowledge_graph_exports").upsert(
    { user_id: userId, html_url: htmlUrl, vault_url: vaultUrl, generated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  return { html_url: htmlUrl, vault_url: vaultUrl, entity_count: graphEntities.length };
}
