/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";
import JSZip from "npm:jszip@3.10.1";
import {
  chunkProfileText,
  chunkRows,
  rowToText,
  type KnowledgeChunk,
} from "./chunking.ts";
import {
  normalizeGraphExtraction,
  type GraphEntity,
  type GraphRelation,
} from "./graph.ts";
import {
  buildGraphHtml,
  buildObsidianNotes,
  type ExportEntity,
  type ExportRelation,
} from "./exports.ts";
import {
  errorResponse,
  handleCorsOptions,
  jsonResponse,
  unauthorizedResponse,
} from "../_shared/cors.ts";
import {
  embedKnowledge,
  embeddingRecord,
  resolveEmbeddingConfig,
} from "../_shared/knowledgeEmbeddings.ts";

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
const GRAPH_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GRAPH_MODEL = "gemini-2.5-flash";
const GRAPH_TIMEOUT_MS = 25_000;

interface StoredChunk {
  id: string;
  content: string;
}

interface GraphExtractionResult {
  entities: number;
  relations: number;
  failures: number;
}

async function replaceChunks(
  admin: AdminClient,
  sourceId: string,
  userId: string,
  chunks: KnowledgeChunk[],
): Promise<StoredChunk[]> {
  const embeddingConfig = resolveEmbeddingConfig();
  const embeddings = await embedKnowledge(
    chunks.map((chunk) => chunk.content),
    embeddingConfig,
  );

  if (embeddingConfig.provider === "ollama") {
    const { data: existingChunks, error: existingError } = await (admin as any)
      .from("ai_knowledge_chunks")
      .select("id, content")
      .eq("source_id", sourceId);
    if (existingError) throw existingError;
    if (existingChunks?.length) {
      const sameChunks =
        existingChunks.length === chunks.length &&
        existingChunks.every((storedChunk: StoredChunk, index: number) =>
          storedChunk.content === chunks[index].content,
        );
      if (!sameChunks) {
        throw new Error(
          "Ollama pilot will not replace changed Gemini chunks; use the controlled backfill",
        );
      }
      for (let index = 0; index < existingChunks.length; index += 1) {
        const { error } = await (admin as any)
          .from("ai_knowledge_chunks")
          .update(embeddingRecord(embeddingConfig, embeddings[index]))
          .eq("id", existingChunks[index].id);
        if (error) throw error;
      }
      return existingChunks as StoredChunk[];
    }

    const { data, error } = await (admin as any)
      .from("ai_knowledge_chunks")
      .insert(
        chunks.map((chunk, index) => ({
          source_id: sourceId,
          user_id: userId,
          content: chunk.content,
          metadata: chunk.metadata,
          ...embeddingRecord(embeddingConfig, embeddings[index]),
        })),
      )
      .select("id, content");
    if (error) throw error;
    return data as StoredChunk[];
  }

  const { error: deleteError } = await (admin as any)
    .from("ai_knowledge_chunks")
    .delete()
    .eq("source_id", sourceId);
  if (deleteError) throw deleteError;
  if (!chunks.length) return [];
  const { data, error } = await (admin as any)
    .from("ai_knowledge_chunks")
    .insert(
      chunks.map((chunk, index) => ({
        source_id: sourceId,
        user_id: userId,
        content: chunk.content,
        metadata: chunk.metadata,
        ...embeddingRecord(embeddingConfig, embeddings[index]),
      })),
    )
    .select("id, content");
  if (error) throw error;
  return data as StoredChunk[];
}

function graphPrompt(content: string): string {
  return [
    "Extract a compact business knowledge graph from the text below.",
    "Return JSON only: {entities:[{name,type,description}],relations:[{source,target,relation}]}",
    "Use short, factual names. Only relate entities that appear in the text.",
    "Text:",
    content,
  ].join("\n");
}

// gemini-2.5-flash wraps its output in ```json fences unless response_format
// forces a bare object, so JSON.parse(output) threw on every chunk (the graph
// stayed silently empty). Request json_object AND strip fences defensively.
function parseGraphJson(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse((fenced ? fenced[1] : output).trim());
}

async function extractChunkGraph(content: string) {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");
  const response = await fetch(GRAPH_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GRAPH_MODEL,
      temperature: 0,
      // Rich chunks can emit >1000 tokens of JSON; too low a cap truncates the
      // object mid-string and the chunk's whole graph is lost on parse failure.
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: graphPrompt(content) }],
    }),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || "Graph extraction failed");
  const output = payload?.choices?.[0]?.message?.content;
  if (typeof output !== "string") throw new Error("Graph extraction returned no JSON");
  return normalizeGraphExtraction(parseGraphJson(output));
}

async function upsertGraphEntity(
  admin: AdminClient,
  userId: string,
  entity: GraphEntity,
): Promise<string> {
  const { data, error } = await (admin as any)
    .from("ai_knowledge_entities")
    .upsert(
      { user_id: userId, name: entity.name, type: entity.type, description: entity.description },
      { onConflict: "user_id,normalized_name,type" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function storeChunkGraph(
  admin: AdminClient,
  userId: string,
  chunk: StoredChunk,
): Promise<{ entities: number; relations: number }> {
  const graph = await extractChunkGraph(chunk.content);
  const entityIds = new Map<string, string>();
  for (const entity of graph.entities) {
    entityIds.set(entity.name.toLowerCase(), await upsertGraphEntity(admin, userId, entity));
  }
  const rows = graph.relations.flatMap((relation: GraphRelation) => {
    const sourceId = entityIds.get(relation.source.toLowerCase());
    const targetId = entityIds.get(relation.target.toLowerCase());
    if (!sourceId || !targetId) return [];
    return [{
      user_id: userId,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relation: relation.relation,
      source_chunk_id: chunk.id,
    }];
  });
  if (rows.length) {
    const { error } = await (admin as any).from("ai_knowledge_relations").insert(rows);
    if (error) throw error;
  }
  return { entities: graph.entities.length, relations: rows.length };
}

// One Gemini call per chunk, so bound the work per ingest: cap the chunk count
// and run a small worker pool. Without this a large source fires dozens of
// sequential 25s calls and the edge isolate is killed mid-request (opaque 500)
// even though the source was already marked "ready".
const MAX_GRAPH_CHUNKS = 50;
const GRAPH_CONCURRENCY = 3;

async function extractKnowledgeGraph(
  admin: AdminClient,
  userId: string,
  chunks: StoredChunk[],
): Promise<GraphExtractionResult> {
  const result = { entities: 0, relations: 0, failures: 0 };
  const queue = chunks.slice(0, MAX_GRAPH_CHUNKS);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const chunk = queue[cursor++];
      try {
        const stored = await storeChunkGraph(admin, userId, chunk);
        result.entities += stored.entities;
        result.relations += stored.relations;
      } catch (error) {
        result.failures++;
        console.error("[ai-knowledge-ingest] Graph extraction failed:", message(error));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GRAPH_CONCURRENCY, queue.length) }, worker),
  );
  return result;
}

async function pruneGraphEntities(admin: AdminClient, userId: string) {
  const { error } = await (admin as any).rpc("prune_ai_knowledge_entities", {
    p_user_id: userId,
  });
  if (error) throw error;
}

async function updateKnowledgeGraph(
  admin: AdminClient,
  userId: string,
  chunks: StoredChunk[],
): Promise<GraphExtractionResult> {
  const result = await extractKnowledgeGraph(admin, userId, chunks);
  try {
    await pruneGraphEntities(admin, userId);
  } catch (error) {
    result.failures++;
    console.error("[ai-knowledge-ingest] Graph cleanup failed:", message(error));
  }
  return result;
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

async function cloudinarySignature(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadGraphExport(
  contents: Uint8Array | string,
  fileName: string,
  contentType: string,
  userEmail: string,
): Promise<string> {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary is not configured");
  const folder = `media/${sanitizeEmailForFolder(userEmail)}/knowledge-graph`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await cloudinarySignature(
    `folder=${folder}&overwrite=true&public_id=${fileName}&timestamp=${timestamp}${apiSecret}`,
  );
  const form = new FormData();
  const body = typeof contents === "string"
    ? contents
    : (new Uint8Array(contents).buffer as ArrayBuffer);
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
  if (!response.ok) throw new Error(payload?.error?.message || "Graph export upload failed");
  return payload.secure_url;
}

async function createGraphExports(admin: AdminClient, userId: string, userEmail: string) {
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
    uploadGraphExport(buildGraphHtml(graphEntities, graphRelations), "graph.html", "text/html", userEmail),
    uploadGraphExport(
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
    if (action === "export_graph") {
      try {
        const exported = await createGraphExports(admin, user.id, user.email || user.id);
        await logKnowledgeEvent(admin, user.id, "export_graph", true, exported);
        return jsonResponse({ ok: true, ...exported });
      } catch (error) {
        await logKnowledgeEvent(admin, user.id, "export_graph", false, {
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error));
      }
    }
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
      await updateKnowledgeGraph(admin, user.id, []);
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
      if (source.source_type === "excel") {
        const { error } = await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "pending", error: null })
          .eq("id", source.id);
        if (error) throw error;
        await logKnowledgeEvent(admin, user.id, "queue_excel_source", true, {
          source_id: source.id,
          file_name: source.file_name,
        });
        return jsonResponse({ ok: true, queued: true }, 202);
      }
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
        const storedChunks = await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        const graph = await updateKnowledgeGraph(admin, user.id, storedChunks);
        await logKnowledgeEvent(admin, user.id, "extract_graph", graph.failures === 0, {
          source_id: source.id,
          entity_count: graph.entities,
          relation_count: graph.relations,
          failed_chunks: graph.failures,
        });
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
        await updateKnowledgeGraph(admin, user.id, []);
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
        const storedChunks = await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        const graph = await updateKnowledgeGraph(admin, user.id, storedChunks);
        await logKnowledgeEvent(admin, user.id, "extract_graph", graph.failures === 0, {
          source_id: source.id,
          entity_count: graph.entities,
          relation_count: graph.relations,
          failed_chunks: graph.failures,
        });
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
        const storedChunks = await replaceChunks(admin, source.id, user.id, chunks);
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", source.id);
        const graph = await updateKnowledgeGraph(admin, user.id, storedChunks);
        await logKnowledgeEvent(admin, user.id, "extract_graph", graph.failures === 0, {
          source_id: source.id,
          entity_count: graph.entities,
          relation_count: graph.relations,
          failed_chunks: graph.failures,
        });
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
