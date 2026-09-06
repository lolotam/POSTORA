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
import { extractImageText, parseSourceFile } from "./parsing.ts";
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
  claimEmbeddingColumnOwnership,
  dualEmbeddingRecord,
  embedKnowledgeDual,
  resolveDualEmbeddingConfigFromDb,
} from "../_shared/knowledgeEmbeddings.ts";
import { deleteFromOpeninary, getOpeninaryConfig, openinaryDeliveryUrl } from "../_shared/openinary.ts";
import {
  STORAGE_REF_SCHEME,
  resolveExportUrl,
} from "../_shared/knowledgeExportUrls.ts";
import {
  cloudinaryFolderForEmail,
  downloadKnowledgeFile,
  locateKnowledgeFile,
  type KnowledgeFileOwner,
} from "../_shared/knowledgeSourceFiles.ts";
import { validateKnowledgeUrl } from "../_shared/knowledgeUrl.ts";
import {
  firecrawlCancelCrawl,
  firecrawlScrape,
  firecrawlStartCrawl,
  resolveFirecrawlKey,
} from "../_shared/firecrawl.ts";
import {
  listSourceAccounts,
  parseSetSourceVisibilityInput,
  setSourceVisibility,
  type SetSourceVisibilityInput,
  SourceVisibilityError,
} from "./sourceVisibility.ts";

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
  const embeddingConfig = await resolveDualEmbeddingConfigFromDb(admin);
  const embeddings = await embedKnowledgeDual(
    chunks.map((chunk) => chunk.content),
    embeddingConfig,
  );

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
        ...dualEmbeddingRecord(embeddingConfig, embeddings, index),
      })),
    )
    .select("id, content");
  if (error) throw error;
  await claimEmbeddingColumnOwnership(admin, embeddingConfig);
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
// How many chunks the inline path will embed before handing the source to the
// queue worker instead. Bounded by chunk count rather than bytes because chunks
// are what the embedding calls are billed and timed by: a 14KB markdown made 10
// chunks and finished, a 65KB one exceeded the ~60s edge ceiling and was killed
// with its row stranded in `processing`. Small files keep the fast inline path
// and immediate feedback; anything larger goes somewhere it can be resumed.
const MAX_INLINE_CHUNKS = 25;

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

// Reads a source's bytes. file_path is owner-writable through RLS while this
// runs as the service role, so the location is resolved — and scope-checked
// against the owner — before anything is fetched.
async function downloadSourceFile(
  admin: AdminClient,
  filePath: string,
  owner: KnowledgeFileOwner,
): Promise<Blob> {
  const location = locateKnowledgeFile(filePath, owner);
  if (!location) throw new Error("Knowledge file location is not allowed");
  return await downloadKnowledgeFile(admin, location);
}


async function cloudinarySignature(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadGraphExport(
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
      .from(BUCKET)
      .upload(storagePath, body, {
        contentType,
        upsert: true,
      });
    if (!storageError) {
      // Store a durable backend reference, not a URL: the bucket is private
      // (a public /object/public/ URL would bypass owner checks and is being
      // removed), and a pre-signed URL would expire in the row. The owner gets
      // a short-TTL signed URL from the resolve_export_urls action.
      return `${STORAGE_REF_SCHEME}${BUCKET}/${storagePath.replace(/^\/+/, "")}`;
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

// Stored export values are durable references or external delivery URLs, never
// browser-ready storage links — resolve them to signed URLs for the owner.
async function resolveExportUrlsForRow(
  admin: AdminClient,
  userEmail: string,
  htmlUrl: string | null,
  vaultUrl: string | null,
) {
  const ownerFolder = `media/${cloudinaryFolderForEmail(userEmail)}`;
  const [resolvedHtml, resolvedVault] = await Promise.all([
    resolveExportUrl(admin, htmlUrl, { bucket: BUCKET, ownerFolder }),
    resolveExportUrl(admin, vaultUrl, { bucket: BUCKET, ownerFolder }),
  ]);
  return { html_url: resolvedHtml, vault_url: resolvedVault };
}

// Best-effort cleanup for both storage generations; a leftover file must not
// block deleting the knowledge source row.
async function deleteSourceFile(
  admin: AdminClient,
  filePath: string,
  owner: KnowledgeFileOwner,
): Promise<void> {
  try {
    const location = locateKnowledgeFile(filePath, owner);
    if (!location) {
      console.warn("[ai-knowledge-ingest] Skipping cleanup outside caller folder");
      return;
    }
    if (location.kind === "storage") {
      await admin.storage.from(location.bucket).remove([location.path]);
      return;
    }
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
    const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
    if (!cloudName || !apiKey || !apiSecret) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await cloudinarySignature(
      `invalidate=true&public_id=${location.publicId}&timestamp=${timestamp}${apiSecret}`,
    );
    const form = new FormData();
    form.append("public_id", location.publicId);
    form.append("invalidate", "true");
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


/** Page limits for a whole-site crawl. Matched by the UI's number input. */
const MIN_CRAWL_PAGES = 1;
const MAX_CRAWL_PAGES = 200;
const DEFAULT_CRAWL_PAGES = 50;
/** file_name is what the sources list shows; a full URL would push the row wide. */
const MAX_SOURCE_NAME = 120;

/**
 * A readable name for a scraped source.
 *
 * Never throws. The caller validates the URL first, so an unparseable one
 * cannot normally reach here -- but a naming helper that could throw would turn
 * a cosmetic problem into a failed ingest.
 */
export function buildWebsiteSourceName(url: string, mode: "page" | "site"): string {
  let host = url;
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname === "/" ? "" : parsed.pathname;
  } catch {
    // Fall through with the raw string.
  }
  const name = mode === "site" ? `${host} (whole site)` : `${host}${path}`;
  return name.length > MAX_SOURCE_NAME ? `${name.slice(0, MAX_SOURCE_NAME - 1)}…` : name;
}

// Named rather than passed inline so the module can be imported by a test
// without starting a server -- the same convention n8n-api and the knowledge
// worker already use.
async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return handleCorsOptions();
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) return unauthorizedResponse();
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const anon = createClient(url, anonKey);
    const admin = createClient(url, serviceKey);
    // Carries the caller's JWT, so auth.uid() resolves inside SECURITY DEFINER
    // functions that derive ownership from it. create_ai_knowledge_source is
    // one: called through `admin` it raises "Not authenticated" before doing
    // anything, because a service-role connection has no end user. The upload
    // path never hit this -- it calls the RPC straight from the browser.
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    let user: any = null;
    const { data: userData, error: userError } = await anon.auth.getUser(token);
    if (!userError && userData?.user) {
      user = userData.user;
    } else {
      const { data: adminUserData, error: adminUserError } = await admin.auth.getUser(token);
      if (!adminUserError && adminUserData?.user) {
        user = adminUserData.user;
      }
    }
    if (!user) return unauthorizedResponse();
    const body = await req.json();
    const { action } = body;
    if (action === "export_graph") {
      try {
        const exported = await createGraphExports(admin, user.id, user.email || user.id);
        // The row stores durable references; the response carries signed URLs
        // so a client that opens the export right away gets a working link.
        const urls = await resolveExportUrlsForRow(
          admin,
          user.email || user.id,
          exported.html_url,
          exported.vault_url,
        );
        await logKnowledgeEvent(admin, user.id, "export_graph", true, exported);
        return jsonResponse({ ok: true, ...exported, ...urls });
      } catch (error) {
        await logKnowledgeEvent(admin, user.id, "export_graph", false, {
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error));
      }
    }
    if (action === "resolve_export_urls") {
      // Read-only: only the caller's own stored row is read — no path is ever
      // taken from the request, and signing is scoped to the caller's folder.
      const { data: exportRow } = await (admin as any)
        .from("ai_knowledge_graph_exports")
        .select("html_url, vault_url, generated_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!exportRow) return errorResponse("Knowledge graph exports not found", 404);
      const urls = await resolveExportUrlsForRow(
        admin,
        user.email || user.id,
        exportRow.html_url,
        exportRow.vault_url,
      );
      await logKnowledgeEvent(admin, user.id, "resolve_export_urls", true, {
        html_resolved: exportRow.html_url ? urls.html_url !== null : null,
        vault_resolved: exportRow.vault_url ? urls.vault_url !== null : null,
      });
      return jsonResponse({ ok: true, ...urls, generated_at: exportRow.generated_at });
    }
    if (action === "delete_source") {
      const { data: source } = await (admin as any)
        .from("ai_knowledge_sources")
        .select("*")
        .eq("id", body.source_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!source) return errorResponse("Knowledge source not found", 404);
      if (source.file_path) {
        await deleteSourceFile(admin, source.file_path, { userId: user.id, email: user.email });
      }
      // A website source deleted mid-crawl leaves a job running and billing at
      // Firecrawl with nothing left pointing at it. Best-effort and never
      // blocking: the row the user asked to remove goes either way.
      const crawlJobId = source.source_type === "website" &&
          typeof source.metadata?.crawl_job_id === "string"
        ? source.metadata.crawl_job_id
        : null;
      let crawlCancelled: boolean | null = null;
      if (crawlJobId && ["pending", "processing"].includes(source.status)) {
        try {
          const key = await resolveFirecrawlKey(admin);
          crawlCancelled = await firecrawlCancelCrawl(key, crawlJobId);
        } catch (error) {
          console.error("[ai-knowledge-ingest] Could not cancel crawl:", message(error));
          crawlCancelled = false;
        }
      }
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
        // Recorded so a crawl that outlived its source is findable rather than
        // merely lost.
        ...(crawlJobId ? { crawl_job_id: crawlJobId, crawl_cancelled: crawlCancelled } : {}),
      });
      return jsonResponse({ ok: true });
    }
    // Visibility and links are managed together, through the
    // set_ai_knowledge_source_visibility RPC, so a failure can never leave
    // them disagreeing. Validation and ownership refusals live in
    // ./sourceVisibility.ts, which is where they are testable.
    if (action === "list_source_accounts") {
      const sourceId = body.source_id;
      if (typeof sourceId !== "string" || !sourceId) {
        return errorResponse("source_id is required", 400);
      }
      try {
        const view = await listSourceAccounts(admin, { userId: user.id, sourceId });
        if (!view) return errorResponse("Knowledge source not found", 404);
        return jsonResponse({
          ok: true,
          visibility: view.visibility,
          social_account_ids: view.socialAccountIds,
        });
      } catch (error) {
        return errorResponse(message(error));
      }
    }
    if (action === "set_source_visibility") {
      let input: SetSourceVisibilityInput;
      try {
        input = parseSetSourceVisibilityInput(body);
      } catch (error) {
        const status = error instanceof SourceVisibilityError ? error.status : 400;
        return errorResponse(message(error), status);
      }
      try {
        await setSourceVisibility(admin, { userId: user.id, input });
        await logKnowledgeEvent(admin, user.id, "set_source_visibility", true, {
          source_id: input.sourceId,
          visibility: input.visibility,
          social_account_count: input.socialAccountIds.length,
        });
        return jsonResponse({ ok: true });
      } catch (error) {
        await logKnowledgeEvent(admin, user.id, "set_source_visibility", false, {
          source_id: input.sourceId,
          visibility: input.visibility,
          error: message(error).slice(0, 500),
        });
        const status = error instanceof SourceVisibilityError ? error.status : 400;
        return errorResponse(message(error), status);
      }
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
      // Excel and CSV both go to the worker queue: a large tabular file takes
      // hours to embed and cannot finish inside the edge worker's ~60s ceiling.
      // chunk_count is zeroed so the worker starts (or restarts) from scratch.
      if (source.source_type === "excel" || source.source_type === "csv") {
        const { error } = await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "pending", chunk_count: 0, error: null })
          .eq("id", source.id);
        if (error) throw error;
        await logKnowledgeEvent(admin, user.id, "queue_spreadsheet_source", true, {
          source_id: source.id,
          source_type: source.source_type,
          file_name: source.file_name,
        });
        return jsonResponse({ ok: true, queued: true }, 202);
      }
      try {
        await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "processing", error: null })
          .eq("id", source.id);
        const file = await downloadSourceFile(admin, source.file_path, {
          userId: user.id,
          email: user.email,
        });
        const chunks = await parseSourceFile(
          source.source_type,
          source.file_name || source.file_path,
          file,
        );
        // Parsing is cheap; embedding is what runs out of time. Once the chunk
        // count says this cannot finish inline, hand it to the queue worker
        // rather than starting work that will be killed halfway. chunk_count is
        // zeroed so the worker starts from a clean checkpoint.
        if (chunks.length > MAX_INLINE_CHUNKS) {
          const { error: queueError } = await (admin as any)
            .from("ai_knowledge_sources")
            // queued_at is the handoff, not the status. Every source is created
            // `pending`, so status alone cannot tell "not started" from "given
            // to the worker" -- and the worker's 15s poll would otherwise claim
            // an ordinary small upload while this path was still processing it.
            .update({
              status: "pending",
              chunk_count: 0,
              error: null,
              queued_at: new Date().toISOString(),
            })
            .eq("id", source.id);
          if (queueError) throw queueError;
          // KNOWN GAP, recorded rather than hidden: the inline path runs graph
          // extraction after storing chunks, and the queue worker does not. So
          // a document contributes entities and relations when it is small and
          // none when it is large, which would silently thin the graph exports
          // and graph-expanded answers. Retrieval itself is unaffected -- the
          // chunks are embedded and searchable either way.
          //
          // Logged as a field so the affected sources are queryable when the
          // worker learns to do graph extraction within its deadline budget.
          await logKnowledgeEvent(admin, user.id, "queue_large_source", true, {
            source_id: source.id,
            source_type: source.source_type,
            file_name: source.file_name,
            chunk_count: chunks.length,
            graph_extraction: "deferred",
          });
          return jsonResponse({ ok: true, queued: true, chunks: chunks.length }, 202);
        }
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
    if (action === "ingest_website") {
      // Validated BEFORE anything is created. A rejected URL must never leave a
      // source row behind, or the list shows a site that was never read.
      const check = validateKnowledgeUrl(body.url);
      if (!check.ok) {
        // Refusals are logged too. A rejected private host or credentialed URL
        // that leaves no system_logs row is a refusal nobody can explain later.
        // The reason is recorded, never the raw address -- it may carry the
        // credentials that got it rejected.
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
          rejected: check.reason,
          mode: body.mode === "site" ? "site" : "page",
        });
        return errorResponse(check.reason, 400);
      }
      const mode: "page" | "site" = body.mode === "site" ? "site" : "page";
      const requested = Number(body.limit);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), MIN_CRAWL_PAGES), MAX_CRAWL_PAGES)
        : DEFAULT_CRAWL_PAGES;

      let key: string;
      try {
        key = await resolveFirecrawlKey(admin);
      } catch (error) {
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
          mode,
          error: message(error).slice(0, 500),
        });
        // 400, never 5xx: Cloudflare replaces an origin 5xx body with its own
        // page, so the sentence naming the admin setting would never arrive.
        return errorResponse(message(error), 400);
      }

      // A caller asking for account scope MUST name the account. Falling through
      // to `shared` on a blank id was a silent widening: knowledge meant for one
      // brand would become readable by every connected agent. Refuse instead --
      // the request is malformed, and the safe reading of a malformed request is
      // not "share it with everyone".
      // The scope is validated against the closed set, not merely tested for
      // "account". This endpoint takes arbitrary authenticated JSON, not the
      // UI's TypeScript union, so any other value -- a typo, "restricted",
      // "private" -- would otherwise fall through to SHARED and widen access on
      // exactly the input a careful caller thought was narrowing it.
      const requestedScope = body.scope === undefined || body.scope === null
        ? "all"
        : body.scope;
      if (requestedScope !== "account" && requestedScope !== "all") {
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
          rejected: "invalid scope",
          scope: String(requestedScope).slice(0, 50),
        });
        return errorResponse('scope must be "account" or "all".', 400);
      }
      const namedAccount = typeof body.social_account_id === "string"
        ? body.social_account_id.trim()
        : "";
      if (requestedScope === "account" && !namedAccount) {
        // Logged like every other refusal, so an account-scoped request that
        // never happened is not an operational blind spot.
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
          rejected: "account scope with no account id",
        });
        return errorResponse(
          "An account-scoped source must name the account it belongs to.",
          400,
        );
      }
      const scopeToAccount = requestedScope === "account";
      if (body.generate_setup !== undefined && typeof body.generate_setup !== "boolean") {
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, { rejected: "invalid generate_setup" });
        return errorResponse("generate_setup must be a boolean", 400);
      }
      if (body.generate_setup === true) {
        const { data: account, error: accountError } = await (admin as any).from("social_accounts")
          .select("id").eq("id", namedAccount || "00000000-0000-0000-0000-000000000000")
          .eq("user_id", user.id).eq("platform", body.platform).eq("is_active", true).maybeSingle();
        if (accountError || !account || !["whatsapp", "facebook", "instagram", "threads", "youtube"].includes(body.platform)) {
          await logKnowledgeEvent(admin, user.id, "ingest_website", false, { rejected: "setup target unavailable" });
          return errorResponse("Select an active account to generate setup.", 400);
        }
      }
      const { data: sourceId, error: createError } = await (caller as any).rpc(
        "create_ai_knowledge_source",
        {
          p_source_type: "website",
          p_file_name: buildWebsiteSourceName(check.url, mode),
          // The URL IS the file path for a website source; there is no object.
          p_file_path: check.url,
          p_social_account_ids: scopeToAccount ? [namedAccount] : [],
          p_visibility: scopeToAccount ? "restricted" : "shared",
        },
      );
      if (createError) throw createError;
      let setup_error: string | undefined;
      if (body.generate_setup === true) {
        const { error: setupError } = await (caller as any).rpc("create_ai_website_setup_job", {
          p_source_id: sourceId, p_social_account_id: namedAccount, p_platform: body.platform,
        });
        if (setupError) {
          await logKnowledgeEvent(admin, user.id, "ingest_website", false, { source_id: sourceId, rejected: "setup job creation failed" });
          setup_error = "Setup generation could not be queued. Indexing continues; request setup from the indexed source later.";
        }
      }

      // THROWS on a failed write. PostgREST reports failures in the resolved
      // result, not by rejecting, so `await setMeta(...)` would sail past a
      // transient database error -- and for the crawl handoff below that means
      // returning 202 with crawl_job_id and queued_at unwritten: a billable
      // crawl running at Firecrawl that the claim function can never pick up
      // and no one can see. Every caller here is inside a try that marks the
      // source failed, so a throw is recoverable and a silent miss is not.
      const setMeta = async (
        patch: Record<string, unknown>,
        columns: Record<string, unknown> = {},
      ) => {
        const { error: metaError } = await (admin as any)
          .from("ai_knowledge_sources")
          .update({ metadata: { url: check.url, mode, ...patch }, ...columns })
          .eq("id", sourceId);
        if (metaError) throw new Error(`Could not record crawl state: ${message(metaError)}`);
      };

      if (mode === "site") {
        // Held outside the try so a failure AFTER the crawl started can still
        // name the job in the log.
        let startedJobId: string | null = null;
        try {
          const jobId = await firecrawlStartCrawl(key, check.url, limit);
          startedJobId = jobId;
          // queued_at is the handoff. The claim function refuses a website
          // source without it, which is what stops the worker picking this row
          // up before the job id exists.
          await setMeta(
            {
              crawl_job_id: jobId,
              // When the CRAWL started, not when the row was created. The
              // worker times a crawl out after 30 minutes, and a source that
              // sat behind other queued work would otherwise burn that budget
              // before its job was polled once.
              crawl_started_at: new Date().toISOString(),
              stage: "crawling",
              pages_done: 0,
              pages_total: limit,
            },
            { status: "pending", chunk_count: 0, error: null, queued_at: new Date().toISOString() },
          );
          await logKnowledgeEvent(admin, user.id, "ingest_website", true, {
            source_id: sourceId,
            mode,
            url: check.url,
            crawl_job_id: jobId,
            limit,
          });
          return jsonResponse({ ok: true, queued: true, source_id: sourceId, ...(setup_error ? { setup_error } : {}) }, 202);
        } catch (error) {
          // The crawl may already be RUNNING and billable while its id failed to
          // reach source metadata -- which is exactly the state delete-cancel
          // cannot recover from, because it reads the id from there. Cancelling
          // here is the only chance to stop it.
          let cancelled: boolean | null = null;
          if (startedJobId) cancelled = await firecrawlCancelCrawl(key, startedJobId);
          await setFailed(admin, sourceId, error);
          await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
            source_id: sourceId,
            mode,
            url: check.url,
            crawl_cancelled: cancelled,
            // The crawl may already be RUNNING and billable while its id failed
            // to persist. Logging what we know is the only way it stays
            // traceable at all.
            crawl_job_id: startedJobId,
            error: message(error).slice(0, 500),
          });
          return errorResponse(message(error), 400);
        }
      }

      try {
        await setMeta({ stage: "crawling" }, { status: "processing", error: null });
        const page = await firecrawlScrape(key, check.url);
        await setMeta({ stage: "embedding", pages_done: 1, pages_total: 1 });
        // Title and URL lead the text so a retrieved chunk still says which page
        // it came from.
        const chunks = chunkProfileText(`${page.title}\n${page.url}\n\n${page.markdown}`).map((chunk) => ({
          ...chunk, metadata: { ...chunk.metadata, source_url: page.url },
        }));
        if (chunks.length > MAX_INLINE_CHUNKS) {
          // The same handoff the document path makes: parsing is cheap,
          // embedding is what runs out of the ~60s budget.
          await setMeta(
            { stage: "embedding", pages_done: 1, pages_total: 1 },
            { status: "pending", chunk_count: 0, error: null, queued_at: new Date().toISOString() },
          );
          await logKnowledgeEvent(admin, user.id, "ingest_website", true, {
            source_id: sourceId,
            mode,
            url: check.url,
            chunk_count: chunks.length,
            queued: true,
          });
          return jsonResponse({ ok: true, queued: true, source_id: sourceId, chunks: chunks.length, ...(setup_error ? { setup_error } : {}) }, 202);
        }
        const stored = await replaceChunks(admin, sourceId, user.id, chunks);
        // Checked, for the same reason setMeta throws. An unchecked failure here
        // returns 200 while the row stays `processing` -- and a page source has
        // no queued_at, so the claim function will never reclaim it and the UI
        // polls it forever.
        const { error: readyError } = await (admin as any)
          .from("ai_knowledge_sources")
          .update({ status: "ready", chunk_count: chunks.length, error: null })
          .eq("id", sourceId);
        if (readyError) throw new Error(`Could not mark the page indexed: ${message(readyError)}`);
        await updateKnowledgeGraph(admin, user.id, stored);
        await logKnowledgeEvent(admin, user.id, "ingest_website", true, {
          source_id: sourceId,
          mode,
          url: check.url,
          chunk_count: chunks.length,
        });
        return jsonResponse({ ok: true, source_id: sourceId, chunk_count: chunks.length, ...(setup_error ? { setup_error } : {}) });
      } catch (error) {
        await setFailed(admin, sourceId, error);
        await logKnowledgeEvent(admin, user.id, "ingest_website", false, {
          source_id: sourceId,
          mode,
          error: message(error).slice(0, 500),
        });
        return errorResponse(message(error), 400);
      }
    }
    if (action === "ingest_profile_text") {
      const platform = String(body.platform || "whatsapp");
      // Scoped to the account when one is named, because the empty result of
      // an ambiguous read is indistinguishable here from "the profile is
      // empty" -- and that branch DELETES the indexed source. Once a platform
      // can hold several configs, maybeSingle() over (user_id, platform)
      // returns a multiple-rows error; discarding it wiped the business
      // profile of every account on the platform.
      let configQuery = (admin as any)
        .from("ai_agent_configs")
        .select("business_profile_text")
        .eq("user_id", user.id);
      const namedAccount = typeof body.social_account_id === "string" && body.social_account_id.trim()
        ? body.social_account_id.trim()
        : null;
      // Platform is applied in BOTH branches: without it, naming an owned
      // Facebook account with platform "instagram" read the Facebook config
      // and then wrote it into an Instagram-labelled source.
      configQuery = namedAccount
        ? configQuery.eq("platform", platform).eq("social_account_id", namedAccount)
        : configQuery.eq("platform", platform);
      const { data: config, error: configError } = await configQuery.maybeSingle();
      // Never swallowed: an unreadable config must not be read as an empty
      // one, or this deletes knowledge the user still has.
      if (configError) {
        return errorResponse(
          `Could not read the agent config for this ${namedAccount ? "account" : "platform"}: ${message(configError)}`,
        );
      }
      // The source identity carries the account, not just the platform. Two
      // Instagram accounts saving their own profile resolved the SAME
      // "Business profile (instagram)" source, so the second replaced the
      // first's chunks -- and because the source is shared, the first account
      // then answered customers out of the second's business description.
      // A caller naming no account keeps the platform-wide name, which is the
      // row every existing profile already lives under.
      // The whole account id, not a prefix: file_name is the lookup key, and
      // two accounts sharing the first eight UUID characters would resolve the
      // same source -- one brand's profile silently replacing the other's.
      const fileName = namedAccount
        ? `Business profile (${platform} · ${namedAccount})`
        : `Business profile (${platform})`;
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
              // An account's own profile is not shared knowledge: restricting
              // it is what stops one brand's description answering for
              // another. The platform-wide row (no account named) stays
              // shared, which is what it has always been.
              visibility: namedAccount ? "restricted" : "shared",
            })
            .select()
            .single()
        ).data;
      // A restricted source with no link is visible to nobody, so the link is
      // part of creating it rather than a later step. Idempotent: re-indexing
      // an existing profile must not duplicate the row.
      if (namedAccount) {
        const { error: linkError } = await (admin as any)
          .from("ai_knowledge_source_accounts")
          .upsert(
            { source_id: source.id, social_account_id: namedAccount, user_id: user.id },
            { onConflict: "source_id,social_account_id" },
          );
        // A restricted source with no link is readable by nobody, so indexing
        // one would produce chunks that can never be retrieved. Stop instead.
        if (linkError) {
          await (admin as any)
            .from("ai_knowledge_sources")
            .update({ status: "failed", error: message(linkError).slice(0, 500) })
            .eq("id", source.id);
          return errorResponse(`Could not scope the profile to this account: ${message(linkError)}`);
        }
      }
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
}

if (import.meta.main) Deno.serve(handleRequest);
