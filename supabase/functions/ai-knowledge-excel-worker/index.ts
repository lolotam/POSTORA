import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { chunkRows, rowToText, type KnowledgeChunk } from "../ai-knowledge-ingest/chunking.ts";
import { parseSourceFile } from "../ai-knowledge-ingest/parsing.ts";
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
import { chunkProfileText } from "../ai-knowledge-ingest/chunking.ts";
import {
  firecrawlCancelCrawl,
  firecrawlCrawlStatus,
  firecrawlScrape,
  resolveFirecrawlKey,
  type CrawlStatus,
  type FirecrawlPage,
} from "../_shared/firecrawl.ts";
import { downloadKnowledgeFile, locateKnowledgeFile } from "../_shared/knowledgeSourceFiles.ts";

const POLL_MS = 15_000;
// One checkpoint slice equals one embed HTTP batch, so a crash between an
// insert and its checkpoint update loses at most one batch. A batch is not
// cheap: bge-m3 on the CPU-only Ollama takes ~20s for 8 prose chunks
// (measured 2026-09-05), plus the primary provider's call.
const CHECKPOINT_BATCH = EMBED_BATCH_SIZE;
// The edge isolate lives under a ~60s gateway ceiling; stop with headroom so
// the checkpoint update and the JSON summary fit inside the request. A slice
// that runs out hands the row back as `pending` for the next cron tick; the
// claim function's 10-minute stale-`processing` reclaim is only the safety net
// for an isolate that was killed outright.
const WORK_BUDGET_MS = 45_000;
const MIN_REMAINING_MS = 5_000;

type Source = {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  source_type?: string;
  chunk_count?: number | null;
  // Resolved at claim time. Legacy Cloudinary assets are addressed by an
  // email-derived folder, so the owner-scope check needs it; sources already
  // migrated to the private bucket do not.
  owner_email?: string | null;
  // Website sources carry their crawl state here; every other type leaves it {}.
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type WorkerDependencies = {
  embed: (texts: string[], config: DualEmbeddingConfig) => Promise<{ primary: number[][]; fallback: number[][] | null }>;
  resolveConfig: (admin: any) => Promise<DualEmbeddingConfig>;
  now: () => number;
  // Injected so the website path can be tested without reaching Firecrawl.
  //
  // Optional because the spreadsheet and document paths never touch them, and
  // requiring them would make every existing construction of this type -- the
  // ones in index.test.ts included -- a type error that `--no-check` would hide
  // until something called an undefined function at runtime.
  firecrawlKey?: (admin: any) => Promise<string>;
  crawlStatus?: (key: string, jobId: string, fetchImpl?: typeof fetch, deadline?: number) => Promise<CrawlStatus>;
  scrapePage?: (key: string, url: string) => Promise<FirecrawlPage>;
  cancelCrawl?: (key: string, jobId: string) => Promise<boolean>;
};

const defaultDependencies: WorkerDependencies = {
  embed: embedKnowledgeDual,
  resolveConfig: (admin) => resolveDualEmbeddingConfigFromDb(admin),
  now: () => Date.now(),
  firecrawlKey: resolveFirecrawlKey,
  crawlStatus: firecrawlCrawlStatus,
  scrapePage: firecrawlScrape,
  cancelCrawl: firecrawlCancelCrawl,
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

// file_path is owner-writable through RLS while this worker holds the service
// role, so the location is resolved — and scope-checked against the owning
// user — before any byte is fetched.
async function downloadSource(admin: any, source: Source): Promise<Blob> {
  const location = locateKnowledgeFile(source.file_path, {
    userId: source.user_id,
    email: source.owner_email,
  });
  if (!location) throw new Error("Knowledge file location is not allowed");
  return await downloadKnowledgeFile(admin, location);
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
  /**
   * Set when the source was handed BACK to the queue on purpose (a crawl still
   * running upstream). It is `pending` again and the claim orders by created_at,
   * so without this the same row would be re-claimed immediately and polled for
   * the rest of the 45s budget -- hammering the provider and starving every
   * later item. The drain loop stops on it and the next cron tick continues.
   */
  deferred?: boolean;
};

// Process one claimed source resumably:
/**
 * Embed `chunks` for `source`, checkpointing as it goes, and mark it ready.
 *
 * Extracted so the website path reuses the SAME resumability the spreadsheet
 * path has: chunk_count is the durable checkpoint, a resume deletes only the
 * chunks at or past it, and a run that hits the deadline leaves the row
 * `processing` for the next tick rather than losing the work already embedded.
 * A second implementation of this loop would be a second set of crash windows.
 */
async function embedChunksResumably(
  admin: any,
  source: Source,
  chunks: KnowledgeChunk[],
  deps: WorkerDependencies,
  deadline?: number,
): Promise<SourceOutcome> {
  const resumedFrom = source.chunk_count ?? 0;
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
    // Wall time of the previous batch. A batch is only started when one of the
    // same length still fits before the deadline: the deadline check alone let
    // a ~30s batch begin at 40s of a 60s isolate, which killed the isolate mid
    // batch (no code runs after that) and left the row `processing`.
    let lastBatchMs = 0;
    for (let offset = start; offset < chunks.length; offset += CHECKPOINT_BATCH) {
      if (deadline !== undefined && deps.now() + lastBatchMs >= deadline) {
        return await handBackToQueue(admin, source, start, resumedFrom);
      }
      const batchStartedAt = deps.now();
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
      lastBatchMs = deps.now() - batchStartedAt;
    }

    const { error: updateError } = await admin.from("ai_knowledge_sources")
      .update({ status: "ready", chunk_count: chunks.length, error: null, next_attempt_at: null })
      .eq("id", source.id);
    if (updateError) throw updateError;
    console.log(`[ai-knowledge-excel-worker] ready source=${source.id} chunks=${chunks.length} resumed=${resumedFrom > 0}`);
    return { sourceId: source.id, status: "ready", chunkCount: chunks.length, resumed: resumedFrom > 0 };
}

/**
 * Release a source whose slice ran out of budget so the NEXT cron tick resumes
 * it. It goes back to `pending` with its checkpoint intact: the claim takes
 * `pending` rows at once but ignores a `processing` row for ten minutes, so
 * leaving it `processing` (the old behaviour) cost a ten-minute wait per slice
 * and a 50-chunk document took over half an hour to index.
 */
async function handBackToQueue(
  admin: any,
  source: Source,
  chunkCount: number,
  resumedFrom: number,
): Promise<SourceOutcome> {
  const { error } = await admin.from("ai_knowledge_sources")
    .update({ status: "pending" })
    .eq("id", source.id);
  if (error) throw error;
  return {
    sourceId: source.id,
    status: "processing",
    chunkCount,
    resumed: resumedFrom > 0,
    reason: "time budget reached; source handed back to the queue and will be resumed",
    deferred: true,
  };
}

//   * ai_knowledge_sources.chunk_count is the durable checkpoint, advanced only
//     after the batch it counts has landed; status stays `processing` between
//     batches so a crash never loses already-embedded work, and goes back to
//     `pending` when a slice runs out of budget so the next tick resumes it.
//   * Resuming at chunk_count N deletes chunks with chunk_index >= N (the crash
//     window between an insert and its checkpoint) and continues from N.
//   * A fresh claim at chunk_count 0 deletes all existing chunks first.
// `deadline` bounds the HTTP-driven mode; the standalone poller omits it.
// A crawl that has not finished in this long is not going to. The row keeps
// its metadata so the Firecrawl job id is still available to support.
const CRAWL_TIMEOUT_MS = 30 * 60_000;

/** How long a released crawl stays invisible to the claim: one cron interval. */
const DEFER_MS = 2 * 60_000;

async function failSource(admin: any, sourceId: string, detail: string): Promise<SourceOutcome> {
  const reason = detail.slice(0, 500);
  // next_attempt_at is cleared with the terminal state: a failed row the user
  // retries must be claimable at once, not still serving out a deferral.
  await admin.from("ai_knowledge_sources")
    .update({ status: "failed", error: reason, next_attempt_at: null })
    .eq("id", sourceId);
  console.error(`[ai-knowledge-excel-worker] website failed source=${sourceId}: ${reason}`);
  return { sourceId, status: "failed", chunkCount: 0, resumed: false, reason };
}

/** One page becomes one chunk sequence, led by its title and URL so a hit says where it came from. */
function pagesToChunks(pages: FirecrawlPage[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const page of pages) {
    const parts = chunkProfileText(
      `${page.title}\n${page.url}\n\n${page.markdown}`,
    );
    for (const part of parts) {
      chunks.push({ ...part, metadata: { ...part.metadata, source_url: page.url } });
    }
  }
  return chunks;
}

/**
 * A claimed website source: poll its crawl, or re-scrape its single page.
 *
 * A crawl still running is returned to `pending`, NOT left `processing`. The
 * claim already flipped it to processing, and only the 10-minute stale reclaim
 * would touch it again -- so a twenty-page crawl would advance in ten-minute
 * steps instead of on the two-minute cron.
 */
export async function processWebsiteSource(
  admin: any,
  source: Source,
  deps: WorkerDependencies = defaultDependencies,
  deadline?: number,
): Promise<SourceOutcome> {
  const metadata = (source.metadata ?? {}) as Record<string, unknown>;
  const mode = metadata.mode === "site" ? "site" : "page";
  const url = String(metadata.url || source.file_path || "");

  // Throws on a failed write, like its counterpart in ai-knowledge-ingest.
  // Supabase reports write failures in the resolved result, so an unchecked
  // deferral would return `deferred: true` with the row still `processing` and
  // no visibility timeout -- unclaimable until the ten-minute stale reclaim.
  const writeMeta = async (
    patch: Record<string, unknown>,
    columns: Record<string, unknown> = {},
  ) => {
    const { error: writeError } = await admin.from("ai_knowledge_sources")
      .update({ metadata: { ...metadata, ...patch }, ...columns })
      .eq("id", source.id);
    if (writeError) throw new Error(`Could not record crawl state: ${message(writeError)}`);
  };

  let key: string;
  try {
    key = await (deps.firecrawlKey ?? resolveFirecrawlKey)(admin);
  } catch (error) {
    return await failSource(admin, source.id, message(error));
  }

  if (mode === "page") {
    // The page path reaches the queue only when one page produced more chunks
    // than fit inline. Re-scraping is one cheap call; storing the markdown on
    // the row would put a whole page into a jsonb column that every list query
    // reads.
    if (!url) return await failSource(admin, source.id, "This source has no address to scrape");
    try {
      await writeMeta({ stage: "embedding", pages_done: 1, pages_total: 1 });
      const page = await (deps.scrapePage ?? firecrawlScrape)(key, url);
      const chunks = pagesToChunks([page]);
      if (!chunks.length) {
        return await failSource(admin, source.id, "That page had no readable text");
      }
      return await embedChunksResumably(admin, source, chunks, deps, deadline);
    } catch (error) {
      return await failSource(admin, source.id, message(error));
    }
  }

  const jobId = typeof metadata.crawl_job_id === "string" ? metadata.crawl_job_id : "";
  if (!jobId) {
    return await failSource(admin, source.id, "This crawl has no job id and cannot be resumed");
  }

  let status: CrawlStatus;
  try {
    // The worker's own deadline bounds pagination too, so a slow-paginating
    // crawl cannot eat the whole budget before anything is embedded.
    status = await (deps.crawlStatus ?? firecrawlCrawlStatus)(key, jobId, undefined, deadline);
  } catch (error) {
    return await failSource(admin, source.id, message(error));
  }

  if (status.state === "failed") {
    return await failSource(admin, source.id, status.error || "The crawl failed");
  }

  if (status.state === "running") {
    // From when the CRAWL started, falling back to the row for sources queued
    // before crawl_started_at existed. Timing from created_at alone would let
    // a source that waited behind other work exhaust the budget before its
    // job was polled once.
    const startedRaw = typeof metadata.crawl_started_at === "string"
      ? metadata.crawl_started_at
      : source.created_at;
    const startedAt = startedRaw ? Date.parse(startedRaw) : NaN;
    if (Number.isFinite(startedAt) && deps.now() - startedAt > CRAWL_TIMEOUT_MS) {
      // Cancel before terminalising. The delete path only cancels sources that
      // are still pending or processing, so a row failed here and then deleted
      // could never stop the job -- it would keep consuming credits with no
      // tracked source pointing at it.
      await (deps.cancelCrawl ?? firecrawlCancelCrawl)(key, jobId);
      return await failSource(admin, source.id, "Crawl timed out after 30 minutes");
    }
    try {
      await writeMeta(
      { stage: "crawling", pages_done: status.completed, pages_total: status.total },
      {
        // Back to pending so a later tick can claim it. Left `processing`, it
        // would wait for the ten-minute stale reclaim instead.
        status: "pending",
        error: null,
        // ...but NOT eligible immediately. The claim orders globally by
        // created_at, so without this the same crawl is re-selected on every
        // tick and one slow site blocks every later document and crawl, for
        // every user, until it finishes. One cron interval is exactly how long
        // it should wait.
        next_attempt_at: new Date(deps.now() + DEFER_MS).toISOString(),
      },
      );
    } catch (error) {
      // Reporting a deferral that was never written would strand the row.
      return await failSource(admin, source.id, message(error));
    }
    return {
      sourceId: source.id,
      status: "processing",
      chunkCount: source.chunk_count ?? 0,
      resumed: false,
      reason: `crawl in progress (${status.completed}/${status.total})`,
      deferred: true,
    };
  }

  const chunks = pagesToChunks(status.pages);
  if (!chunks.length) {
    // "Ready, 0 chunks" would tell the user their site was read and the agent
    // knows nothing about it.
    return await failSource(admin, source.id, "The crawl returned no readable pages");
  }
  try {
    await writeMeta({
      stage: "embedding",
      pages_done: status.pages.length,
      pages_total: status.total || status.pages.length,
    });
    return await embedChunksResumably(admin, source, chunks, deps, deadline);
  } catch (error) {
    return await failSource(admin, source.id, message(error));
  }
}

export async function processSource(
  admin: any,
  source: Source,
  deps: WorkerDependencies = defaultDependencies,
  deadline?: number,
): Promise<SourceOutcome> {
  // A website source is not a file: there is nothing to download, and its work
  // is a crawl to poll or a page to re-scrape.
  if (source.source_type === "website") {
    return await processWebsiteSource(admin, source, deps, deadline);
  }
  const resumedFrom = source.chunk_count ?? 0;
  try {
    const file = await downloadSource(admin, source);
    // Every source type the inline path understands, not just the tabular two.
    // A large markdown or PDF used to have no queue at all: it ran inline and
    // was killed by the 60s edge ceiling with its row stranded in `processing`.
    const chunks = await parseSourceFile(
      source.source_type || "doc",
      source.file_name || source.file_path,
      file,
    );
    if (!chunks.length) throw new Error("This file contains no indexable content");
    return await embedChunksResumably(admin, source, chunks, deps, deadline);
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
  if (!source) return null;
  return { ...source, owner_email: await ownerEmail(admin, source.user_id) };
}

// The claim RPC returns the source row, which carries no email. A source
// whose owner cannot be resolved keeps a null email: the scope check then
// refuses its legacy Cloudinary asset rather than fetching it unchecked.
async function ownerEmail(admin: any, userId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error(`[ai-knowledge-excel-worker] owner lookup failed: ${error.message}`);
    return null;
  }
  return data?.email ?? null;
}

// The standalone poller claims ONE source per tick and then sleeps, so a
// deferred crawl waits POLL_MS like everything else -- no extra guard needed
// here, unlike the HTTP drain loop above.
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
    const outcome = await processSource(admin, source, defaultDependencies, deadline);
    outcomes.push(outcome);
    // A deferred source is `pending` again and sorts first by created_at, so
    // continuing would immediately re-claim the one we just put back.
    if (outcome.deferred) break;
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
