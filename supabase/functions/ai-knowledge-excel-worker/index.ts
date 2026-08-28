import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { chunkRows, rowToText, type KnowledgeChunk } from "../ai-knowledge-ingest/chunking.ts";
import { EMBED_BATCH_SIZE } from "../_shared/ollamaEmbeddings.ts";
import {
  claimEmbeddingColumnOwnership,
  dualEmbeddingRecord,
  embedKnowledgeDual,
  resolveDualEmbeddingConfigFromDb,
  type DualEmbeddingConfig,
} from "../_shared/knowledgeEmbeddings.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";

const CLOUDINARY_CDN_PREFIX = "https://res.cloudinary.com/";
const POLL_MS = 15_000;
// One checkpoint slice equals one Ollama embed HTTP batch (~2-3s), so a crash
// between an insert and its checkpoint update loses at most one small batch.
const CHECKPOINT_BATCH = EMBED_BATCH_SIZE;
// The edge isolate lives under a ~60s gateway ceiling; stop with headroom so
// the checkpoint update and the JSON summary fit inside the request. The claim
// function's 10-minute stale-`processing` reclaim re-picks the source up.
const WORK_BUDGET_MS = 45_000;
const MIN_REMAINING_MS = 5_000;

type Source = {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  source_type?: string;
  chunk_count?: number | null;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type WorkerDependencies = {
  embed: (texts: string[], config: DualEmbeddingConfig) => Promise<{ primary: number[][]; fallback: number[][] | null }>;
  resolveConfig: (admin: any) => Promise<DualEmbeddingConfig>;
  now: () => number;
};

const defaultDependencies: WorkerDependencies = {
  embed: embedKnowledgeDual,
  resolveConfig: (admin) => resolveDualEmbeddingConfigFromDb(admin),
  now: () => Date.now(),
};

function workbookToChunks(bytes: ArrayBuffer): KnowledgeChunk[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const rows: Array<{ text: string; sheet: string; row: number }> = [];
  for (const sheet of workbook.SheetNames) {
    XLSX.utils
      .sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheet], { defval: "" })
      .forEach((row, index) => rows.push({ text: rowToText(row), sheet, row: index + 2 }));
  }
  return chunkRows(rows);
}

export function parseExcelChunks(bytes: ArrayBuffer): KnowledgeChunk[] {
  return workbookToChunks(bytes);
}

// SheetJS sniffs the bytes, so CSV text arrives as a single-sheet workbook and
// flows through the same rowToText/chunkRows pipeline as Excel — identical
// chunk shapes for both tabular source types.
export function parseCsvChunks(bytes: ArrayBuffer): KnowledgeChunk[] {
  return workbookToChunks(bytes);
}

async function downloadSource(admin: any, filePath: string): Promise<Blob> {
  if (filePath.startsWith(CLOUDINARY_CDN_PREFIX)) {
    const response = await fetch(filePath);
    if (!response.ok) throw new Error(`Knowledge file download failed (${response.status})`);
    return response.blob();
  }
  if (/^https?:\/\//.test(filePath)) throw new Error("Knowledge file URL is not allowed");
  const { data, error } = await admin.storage.from("ai-knowledge").download(filePath);
  if (error || !data) throw error || new Error("Knowledge file not found");
  return data;
}

// Delete only the chunks a resume will rewrite: everything at or past the
// checkpoint, plus any row without a chunk_index (pre-checkpointing leftovers
// from an aborted legacy run — with a positive checkpoint they can only be
// garbage). The 0..checkpoint-1 prefix stays untouched.
async function deleteChunksFrom(admin: any, sourceId: string, fromIndex: number) {
  const { data, error } = await admin.from("ai_knowledge_chunks")
    .select("id, metadata")
    .eq("source_id", sourceId);
  if (error) throw error;
  const doomed: string[] = [];
  for (const row of data || []) {
    const raw = (row.metadata as Record<string, unknown> | null)?.chunk_index;
    const index = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(index) || index >= fromIndex) doomed.push(row.id as string);
  }
  if (doomed.length) {
    const { error: deleteError } = await admin.from("ai_knowledge_chunks").delete().in("id", doomed);
    if (deleteError) throw deleteError;
  }
}

export type SourceOutcome = {
  sourceId: string;
  status: "ready" | "processing" | "failed";
  chunkCount: number;
  resumed: boolean;
  reason?: string;
};

// Process one claimed source resumably:
//   * ai_knowledge_sources.chunk_count is the durable checkpoint, advanced only
//     after the batch it counts has landed; status stays `processing` between
//     batches so a crash never loses already-embedded work.
//   * Resuming at chunk_count N deletes chunks with chunk_index >= N (the crash
//     window between an insert and its checkpoint) and continues from N.
//   * A fresh claim at chunk_count 0 deletes all existing chunks first.
// `deadline` bounds the HTTP-driven mode; the standalone poller omits it.
export async function processSource(
  admin: any,
  source: Source,
  deps: WorkerDependencies = defaultDependencies,
  deadline?: number,
): Promise<SourceOutcome> {
  const resumedFrom = source.chunk_count ?? 0;
  try {
    const file = await downloadSource(admin, source.file_path);
    const bytes = await file.arrayBuffer();
    const chunks = source.source_type === "csv"
      ? parseCsvChunks(bytes)
      : parseExcelChunks(bytes);
    if (!chunks.length) throw new Error("The workbook contains no indexable rows");
    const embeddingConfig = await deps.resolveConfig(admin);

    // A source whose file shrank below its checkpoint cannot be resumed — the
    // stored prefix belongs to a different chunk sequence — so restart at zero.
    let start = resumedFrom <= chunks.length ? resumedFrom : 0;
    if (start > 0) {
      await deleteChunksFrom(admin, source.id, start);
    } else {
      const { error: deleteError } = await admin.from("ai_knowledge_chunks")
        .delete()
        .eq("source_id", source.id);
      if (deleteError) throw deleteError;
    }

    let ownershipClaimed = false;
    for (let offset = start; offset < chunks.length; offset += CHECKPOINT_BATCH) {
      if (deadline !== undefined && deps.now() >= deadline) {
        return {
          sourceId: source.id,
          status: "processing",
          chunkCount: start,
          resumed: resumedFrom > 0,
          reason: "time budget reached; source stays processing and will be resumed",
        };
      }
      const batch = chunks.slice(offset, offset + CHECKPOINT_BATCH);
      const embeddings = await deps.embed(
        batch.map((chunk) => chunk.content),
        embeddingConfig,
      );
      const { error: insertError } = await admin.from("ai_knowledge_chunks").insert(
        batch.map((chunk, index) => ({
          source_id: source.id,
          user_id: source.user_id,
          content: chunk.content,
          metadata: { ...chunk.metadata, chunk_index: offset + index },
          ...dualEmbeddingRecord(embeddingConfig, embeddings, index),
        })),
      );
      if (insertError) throw insertError;
      start = offset + batch.length;
      const { error: checkpointError } = await admin.from("ai_knowledge_sources")
        .update({ chunk_count: start })
        .eq("id", source.id);
      if (checkpointError) throw checkpointError;
      if (!ownershipClaimed) {
        await claimEmbeddingColumnOwnership(admin, embeddingConfig);
        ownershipClaimed = true;
      }
    }

    const { error: updateError } = await admin.from("ai_knowledge_sources")
      .update({ status: "ready", chunk_count: chunks.length, error: null })
      .eq("id", source.id);
    if (updateError) throw updateError;
    console.log(`[ai-knowledge-excel-worker] ready source=${source.id} chunks=${chunks.length} resumed=${resumedFrom > 0}`);
    return { sourceId: source.id, status: "ready", chunkCount: chunks.length, resumed: resumedFrom > 0 };
  } catch (error) {
    const detail = message(error).slice(0, 500);
    await admin.from("ai_knowledge_sources").update({ status: "failed", error: detail }).eq("id", source.id);
    console.error(`[ai-knowledge-excel-worker] failed source=${source.id}: ${detail}`);
    return { sourceId: source.id, status: "failed", chunkCount: resumedFrom, resumed: resumedFrom > 0, reason: detail };
  }
}

async function claimSource(admin: any): Promise<Source | null> {
  const { data, error } = await admin.rpc("claim_ai_knowledge_excel_source");
  if (error) throw error;
  const source = Array.isArray(data) ? data[0] : data;
  return source ?? null;
}

async function runOnce(admin: any, deps: WorkerDependencies = defaultDependencies) {
  const source = await claimSource(admin);
  if (!source) return null;
  return processSource(admin, source as Source, deps);
}

// HTTP-driven mode (edge function or any cron/ops caller): claim and process
// sources one at a time until the wall-clock budget runs out, then return a
// JSON summary. Authenticated like the other service-invoked functions
// (process-pending-replies): CRON_SECRET or the service-role key.
async function handleWorkerRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = verifyCronAuth(req);
  if (!auth.ok) return auth.response;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return jsonResponse({ error: "Supabase worker configuration is missing" }, 503);
  }
  const admin = createClient(url, serviceKey);

  const startedAt = Date.now();
  const deadline = startedAt + WORK_BUDGET_MS;
  const outcomes: SourceOutcome[] = [];
  while (Date.now() + MIN_REMAINING_MS < deadline) {
    let source: Source | null;
    try {
      source = await claimSource(admin);
    } catch (error) {
      console.error(`[ai-knowledge-excel-worker] queue failure: ${message(error)}`);
      break;
    }
    if (!source) break;
    outcomes.push(await processSource(admin, source, defaultDependencies, deadline));
  }
  return jsonResponse({
    ok: true,
    processed: outcomes.length,
    outcomes,
    elapsed_ms: Date.now() - startedAt,
  });
}

if (import.meta.main) {
  if (Deno.env.get("EXCEL_WORKER_POLL") === "1") {
    // Standalone container mode (docs/runbooks/deploy-ai-knowledge-worker.md):
    // a long-lived poller with no wall-clock budget — resumability still
    // applies because the process can be restarted at any time.
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("Supabase worker configuration is missing");
    const admin = createClient(url, serviceKey);
    while (true) {
      try {
        await runOnce(admin);
      } catch (error) {
        console.error(`[ai-knowledge-excel-worker] queue failure: ${message(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } else {
    // Same import-safe serving convention as n8n-api: the edge runtime loads
    // this file as the main module, while `deno test` imports it as a library.
    Deno.serve(handleWorkerRequest);
  }
}
