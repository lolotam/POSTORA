/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";
import {
  chunkProfileText,
  chunkRows,
  rowToText,
  type KnowledgeChunk,
} from "./chunking.ts";
import {
  errorResponse,
  handleCorsOptions,
  jsonResponse,
  unauthorizedResponse,
} from "../_shared/cors.ts";

const BUCKET = "ai-knowledge";
const GRAPH_API = "https://graph.facebook.com/v21.0";

type AdminClient = any;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function getWhatsAppToken(account: Record<string, unknown>) {
  return String(
    account.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "",
  );
}
// Embeddings run on Gemini's OpenAI-compatible endpoint (OpenAI billing is
// exhausted). EMBED_MODEL and EMBED_DIMENSIONS MUST stay identical to
// ai-agent-reply/index.ts: a mismatch silently returns zero RAG matches at
// query time, because the stored vectors land in a different space.
const EMBED_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMENSIONS = 1536;

async function embed(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key)
    throw new Error(
      "GOOGLE_AI_STUDIO_KEY is not configured; knowledge cannot be indexed.",
    );
  const all: number[][] = [];
  for (let index = 0; index < texts.length; index += 64) {
    const response = await fetch(EMBED_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: texts.slice(index, index + 64),
        dimensions: EMBED_DIMENSIONS,
      }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data?.error?.message || "Embedding request failed");
    all.push(
      ...data.data.map((item: { embedding: number[] }) => item.embedding),
    );
  }
  return all;
}
async function replaceChunks(
  admin: AdminClient,
  sourceId: string,
  userId: string,
  chunks: KnowledgeChunk[],
) {
  const { error: deleteError } = await (admin as any)
    .from("ai_knowledge_chunks")
    .delete()
    .eq("source_id", sourceId);
  if (deleteError) throw deleteError;
  if (!chunks.length) return;
  const embeddings = await embed(chunks.map((chunk) => chunk.content));
  const { error } = await (admin as any)
    .from("ai_knowledge_chunks")
    .insert(
      chunks.map((chunk, index) => ({
        source_id: sourceId,
        user_id: userId,
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: embeddings[index],
      })),
    );
  if (error) throw error;
}
async function setFailed(admin: AdminClient, sourceId: string, error: unknown) {
  await (admin as any)
    .from("ai_knowledge_sources")
    .update({ status: "failed", error: message(error).slice(0, 500) })
    .eq("id", sourceId);
}

// file_path is either a Cloudinary CDN URL (current uploads, stored under
// media/{user}/ai-knowledge/) or a legacy path in the ai-knowledge storage
// bucket. Only res.cloudinary.com is fetched — file_path is user-writable
// via RLS, so any other URL would be an SSRF vector for the service role.
const CLOUDINARY_CDN_PREFIX = "https://res.cloudinary.com/";

async function downloadSourceFile(admin: AdminClient, filePath: string): Promise<Blob> {
  if (filePath.startsWith(CLOUDINARY_CDN_PREFIX)) {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error(`Knowledge file download failed (${response.status})`);
    return await response.blob();
  }
  if (/^https?:\/\//.test(filePath)) throw new Error("Knowledge file URL is not allowed");
  const { data: file, error: downloadError } = await admin.storage.from(BUCKET).download(filePath);
  if (downloadError || !file) throw downloadError || new Error("Knowledge file not found");
  return file;
}

// Same folder-name derivation as cloudinary-upload — the destroy scope
// below depends on both sides computing the identical user folder.
function sanitizeEmailForFolder(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, "_at_")
    .replace(/\./g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
}

// Best-effort cleanup for both storage generations; a leftover file must not
// block deleting the knowledge source row.
async function deleteSourceFile(
  admin: AdminClient,
  filePath: string,
  userEmail: string,
): Promise<void> {
  try {
    if (!filePath.startsWith(CLOUDINARY_CDN_PREFIX)) {
      if (!/^https?:\/\//.test(filePath)) await admin.storage.from(BUCKET).remove([filePath]);
      return;
    }
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
    // URL shape: https://res.cloudinary.com/<cloud>/raw/upload/v<N>/<public_id>
    // (raw public_ids keep their file extension).
    const match = filePath.match(/^https:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\/v\d+\/(.+)$/);
    if (!cloudName || !apiKey || !apiSecret || !match) return;
    const publicId = decodeURIComponent(match[1]);
    // file_path is user-writable via RLS: without this scope check a user
    // could point their row at another user's asset and have the service
    // role destroy it. Only assets inside the caller's own folder qualify.
    if (!publicId.startsWith(`media/${sanitizeEmailForFolder(userEmail)}/`)) {
      console.warn("[ai-knowledge-ingest] Skipping destroy outside caller folder:", publicId);
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const signatureBase = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(signatureBase));
    const signature = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const form = new FormData();
    form.append("public_id", publicId);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    console.error("[ai-knowledge-ingest] File cleanup failed:", message(error));
  }
}

// Mirrors knowledge operations into system_logs so /admin/logs can track
// all AI agent calls (category "ai") alongside ai-agent-reply entries.
async function logKnowledgeEvent(
  admin: AdminClient,
  userId: string,
  action: string,
  ok: boolean,
  detail: Record<string, unknown>,
) {
  const { error } = await (admin as any).from("system_logs").insert({
    source: "ai-knowledge-ingest",
    category: "ai",
    level: ok ? "info" : "error",
    message: `AI knowledge ${action} ${ok ? "succeeded" : "failed"}${detail.error ? `: ${detail.error}` : ""}`,
    user_id: userId,
    metadata: { action, ...detail },
  });
  if (error) console.error("[ai-knowledge-ingest] Failed to write system log:", error.message);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Images become text via a vision model: menus, price lists, and product
// photos get described/transcribed so they are searchable like any document.
// Image OCR runs on Gemini (OpenAI billing is exhausted). Uses the same
// OpenAI-compatible chat endpoint as ai-agent-reply, with a multimodal model.
const VISION_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const VISION_MODEL = "gemini-2.5-flash";

async function extractImageText(bytes: Uint8Array, fileName: string): Promise<string> {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key)
    throw new Error("GOOGLE_AI_STUDIO_KEY is not configured; knowledge cannot be indexed.");
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const mime = IMAGE_MIME_BY_EXTENSION[extension];
  if (!mime) throw new Error(`Unsupported image type: .${extension}`);
  const response = await fetch(VISION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract ALL business-relevant information from this image (product names, prices, descriptions, policies, contact details, menu items). Transcribe visible text verbatim. Output plain text only.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${toBase64(bytes)}` },
            },
          ],
        },
      ],
      max_tokens: 1500,
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data?.error?.message || "Image extraction failed");
  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("No text could be extracted from the image");
  return text;
}

async function parseSourceFile(
  sourceType: string,
  fileName: string,
  file: Blob,
): Promise<KnowledgeChunk[]> {
  if (sourceType === "csv" || sourceType === "excel") {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows: Array<{ text: string; sheet: string; row: number }> = [];
    for (const sheet of workbook.SheetNames) {
      XLSX.utils
        .sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheet], {
          defval: "",
        })
        .forEach((row, index) =>
          rows.push({ text: rowToText(row), sheet, row: index + 2 }),
        );
    }
    return chunkRows(rows);
  }
  if (sourceType === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text?.trim())
      throw new Error("No extractable text found in the PDF (scanned PDFs are not supported yet)");
    return chunkProfileText(text);
  }
  if (sourceType === "doc") {
    const text = (await file.text()).trim();
    if (!text) throw new Error("The document is empty");
    return chunkProfileText(text);
  }
  if (sourceType === "image") {
    const text = await extractImageText(
      new Uint8Array(await file.arrayBuffer()),
      fileName,
    );
    return chunkProfileText(text);
  }
  throw new Error(`Source type not supported: ${sourceType}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return unauthorizedResponse();
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const token = authHeader.replace("Bearer ", "");
    const anon = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await anon.auth.getUser(token);
    if (!user) return unauthorizedResponse();
    const admin = createClient(url, serviceKey);
    const body = await req.json();
    const { action } = body;
    if (action === "delete_source") {
      const { data: source } = await (admin as any)
        .from("ai_knowledge_sources")
        .select("*")
        .eq("id", body.source_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!source) return errorResponse("Knowledge source not found", 404);
      if (source.file_path) await deleteSourceFile(admin, source.file_path, user.email || "");
      const { error } = await (admin as any)
        .from("ai_knowledge_sources")
        .delete()
        .eq("id", source.id);
      if (error) throw error;
      await logKnowledgeEvent(admin, user.id, "delete_source", true, {
        source_id: source.id,
        source_type: source.source_type,
        file_name: source.file_name,
      });
      return jsonResponse({ ok: true });
    }
    if (action === "ingest_source") {
      const { data: source } = await (admin as any)
        .from("ai_knowledge_sources")
        .select("*")
        .eq("id", body.source_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!source) return errorResponse("Knowledge source not found", 404);
      if (!["csv", "excel", "pdf", "doc", "image"].includes(source.source_type))
        return errorResponse("Source type not supported", 400);
      try {
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "processing", error: null })
          .eq("id", source.id);
        const file = await downloadSourceFile(admin, source.file_path);
        const chunks = await parseSourceFile(
          source.source_type,
          source.file_name || source.file_path,
          file,
        );
        await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        await logKnowledgeEvent(admin, user.id, "ingest_source", true, {
          source_id: source.id,
          source_type: source.source_type,
          file_name: source.file_name,
          chunk_count: chunks.length,
        });
        return jsonResponse({ ok: true, chunk_count: chunks.length });
      } catch (error) {
        await setFailed(admin, source.id, error);
        await logKnowledgeEvent(admin, user.id, "ingest_source", false, {
          source_id: source.id,
          source_type: source.source_type,
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error));
      }
    }
    if (action === "ingest_profile_text") {
      const platform = String(body.platform || "whatsapp");
      const { data: config } = await (admin as any)
        .from("ai_agent_configs")
        .select("business_profile_text")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .maybeSingle();
      const fileName = `Business profile (${platform})`;
      const { data: existing } = await (admin as any)
        .from("ai_knowledge_sources")
        .select("*")
        .eq("user_id", user.id)
        .eq("source_type", "profile_text")
        .eq("file_name", fileName)
        .maybeSingle();
      const text = config?.business_profile_text?.trim();
      if (!text) {
        if (existing)
          await (admin as any)
            .from("ai_knowledge_sources")
            .delete()
            .eq("id", existing.id);
        return jsonResponse({ ok: true, chunk_count: 0 });
      }
      const source =
        existing ||
        (
          await (admin as any)
            .from("ai_knowledge_sources")
            .insert({
              user_id: user.id,
              source_type: "profile_text",
              file_name: fileName,
              status: "pending",
            })
            .select()
            .single()
        ).data;
      try {
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "processing", error: null })
          .eq("id", source.id);
        const chunks = chunkProfileText(text);
        await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        await logKnowledgeEvent(admin, user.id, "ingest_profile_text", true, {
          source_id: source.id,
          platform,
          chunk_count: chunks.length,
        });
        return jsonResponse({ ok: true, chunk_count: chunks.length });
      } catch (error) {
        await setFailed(admin, source.id, error);
        await logKnowledgeEvent(admin, user.id, "ingest_profile_text", false, {
          source_id: source.id,
          platform,
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error));
      }
    }
    if (action === "sync_catalog") {
      const { data: account } = await (admin as any)
        .from("social_accounts")
        .select("*")
        .eq("id", body.social_account_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!account || account.platform !== "whatsapp")
        return errorResponse("WhatsApp account not found", 404);
      const token = getWhatsAppToken(account);
      if (!token) throw new Error("WhatsApp access token is unavailable");
      let next: string | null =
        `${GRAPH_API}/${body.catalog_id}/products?fields=id,name,description,price,currency,image_url,url,retailer_id,availability&limit=100`;
      const products: any[] = [];
      for (let page = 0; next && page < 5; page++) {
        const res: Response = await fetch(next, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: any = await res.json();
        if (!res.ok || data.error)
          throw new Error(data?.error?.message || "Catalog request failed");
        products.push(...(data.data || []));
        next = data.paging?.next || null;
      }
      let { data: source } = await (admin as any)
        .from("ai_knowledge_sources")
        .select("*")
        .eq("user_id", user.id)
        .eq("source_type", "catalog")
        .eq("file_name", "WhatsApp catalog")
        .maybeSingle();
      if (!source)
        ({ data: source } = await (admin as any)
          .from("ai_knowledge_sources")
          .insert({
            user_id: user.id,
            source_type: "catalog",
            file_name: "WhatsApp catalog",
            status: "pending",
          })
          .select()
          .single());
      try {
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "processing", error: null })
          .eq("id", source.id);
        const chunks = products.map((product) => ({
          content: [
            `Name: ${product.name || ""}`,
            `Description: ${product.description || ""}`,
            `Price: ${product.price || ""} ${product.currency || ""}`,
            `Availability: ${product.availability || ""}`,
          ].join("\n"),
          metadata: {
            retailer_id: product.retailer_id,
            product_id: product.id,
            url: product.url,
            image_url: product.image_url,
          },
        }));
        await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        await logKnowledgeEvent(admin, user.id, "sync_catalog", true, {
          source_id: source.id,
          catalog_id: body.catalog_id,
          chunk_count: chunks.length,
        });
        return jsonResponse({ ok: true, chunk_count: chunks.length });
      } catch (error) {
        await setFailed(admin, source.id, error);
        await logKnowledgeEvent(admin, user.id, "sync_catalog", false, {
          source_id: source.id,
          catalog_id: body.catalog_id,
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error));
      }
    }
    return errorResponse("Unknown action", 400);
  } catch (error) {
    return errorResponse(message(error));
  }
});
