// Fill one vector column of ai_knowledge_chunks for every chunk that lacks it,
// using the model the admin ladder currently assigns to that column.
//
// Why this exists: changing the model that owns a vector column (for example
// replacing Ollama bge-m3 with Jina in the 1024 column) empties that column,
// and re-ingesting every source would re-parse every file and re-call the
// primary provider for nothing. This embeds only the missing column, straight
// from the stored chunk text, in resumable batches.
//
// Run inside the ai-knowledge-excel-worker container so it inherits the
// provider key, the service role and the in-cluster SUPABASE_URL:
//
//   docker cp scripts/ops/backfill-embedding-column.ts <worker>:/tmp/backfill.ts
//   docker exec -e BACKFILL_COLUMN=embedding_bge_m3 \
//     -e BACKFILL_MODEL=jina/jina-embeddings-v5-omni-small \
//     -e BACKFILL_MAX_CHARS=1100000 <worker> \
//     deno run --allow-env --allow-net --allow-read /tmp/backfill.ts
//
// BACKFILL_MODEL is the provider/model the ladder is expected to assign to the
// column. The ladder resolver falls back to the environment defaults when a
// settings read fails, and the env default for the 1024 column is Ollama; the
// script refuses to run unless the resolved model is the one named, so a
// transient read failure cannot pour the wrong vector space into a column that
// was just cleared for the new one.
//
// BACKFILL_MAX_CHARS caps the run so a metered provider's monthly allowance
// is not spent in one go; rerun later to continue where it stopped. Chunks
// belonging to users with an agent switched on are filled first, so the
// accounts that actually retrieve get their failover vectors before idle ones.
//
// BACKFILL_CHARS_PER_MINUTE paces the run under the provider's per-minute
// token bucket. The default is sized for Jina's 100k tokens/min at the
// measured 0.61 tokens per character of this corpus, with headroom for the
// live ingest that shares the key. Sending faster just earns 429s and retries.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import {
  claimEmbeddingColumnOwnership,
  type EmbeddingConfig,
  embedKnowledge,
  resolveDualEmbeddingConfigFromDb,
} from "/home/deno/functions/_shared/knowledgeEmbeddings.ts";

const BATCH = 64;

const url = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const column = parseColumn(Deno.env.get("BACKFILL_COLUMN"));
const expectedModel = Deno.env.get("BACKFILL_MODEL");
if (!expectedModel) throw new Error("BACKFILL_MODEL (provider/model) is required");

function parseColumn(value: string | undefined): EmbeddingConfig["column"] {
  if (value === "embedding" || value === "embedding_bge_m3") return value;
  throw new Error("BACKFILL_COLUMN must be embedding or embedding_bge_m3");
}
const maxChars = Number(Deno.env.get("BACKFILL_MAX_CHARS") ?? Number.POSITIVE_INFINITY);
const charsPerMinute = Number(Deno.env.get("BACKFILL_CHARS_PER_MINUTE") ?? 130_000);

const admin = createClient(url, serviceKey);

const dual = await resolveDualEmbeddingConfigFromDb(admin);
const config: EmbeddingConfig | null = [dual.primary, dual.fallback].find(
  (tier) => tier?.column === column,
) ?? null;
if (!config) throw new Error(`The admin ladder assigns no model to ${column}; nothing to backfill with`);
if (`${config.provider}/${config.model}` !== expectedModel) {
  throw new Error(
    `The ladder resolved ${column} to ${config.provider}/${config.model}, not ${expectedModel}; refusing to write`,
  );
}
console.log(`backfilling ${column} with ${config.provider}/${config.model} (${config.dimensions}-d)`);

const { data: agentAccounts, error: accountsError } = await admin
  .from("social_accounts")
  .select("user_id")
  .or("account_metadata->>comment_automation_handler.eq.internal,account_metadata->>automation_handler.eq.internal");
if (accountsError) throw accountsError;
const priorityUsers = [...new Set((agentAccounts ?? []).map((row: { user_id: string }) => row.user_id))];

type Chunk = { id: string; content: string };

async function nextBatch(onlyUsers: string[] | null): Promise<Chunk[]> {
  let query = admin
    .from("ai_knowledge_chunks")
    .select("id, content")
    .is(column, null)
    .order("created_at", { ascending: false })
    .limit(BATCH);
  if (onlyUsers) query = query.in("user_id", onlyUsers);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Chunk[];
}

/** The longest prefix of `batch` that still fits under the character cap. */
function withinBudget(batch: Chunk[], remaining: number): Chunk[] {
  let used = 0;
  const kept: Chunk[] = [];
  for (const chunk of batch) {
    if (used + chunk.content.length > remaining) break;
    used += chunk.content.length;
    kept.push(chunk);
  }
  return kept;
}

let chars = 0;
let filled = 0;
let ownershipClaimed = false;
for (const scope of [priorityUsers.length ? priorityUsers : null, null]) {
  while (chars < maxChars) {
    // A batch never exceeds half a minute of the rate budget, so one request
    // cannot trip the per-minute bucket on its own however dense the chunks.
    const batch = withinBudget(await nextBatch(scope), Math.min(maxChars - chars, charsPerMinute / 2));
    if (!batch.length) break;
    const batchChars = batch.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const startedAt = Date.now();
    const vectors = await embedKnowledge(batch.map((chunk) => chunk.content), config, "passage");
    // Each row is written on its own: a partial batch failure must leave the
    // other rows filled, and the next run picks up whatever is still null.
    for (const [index, chunk] of batch.entries()) {
      const { error } = await admin
        .from("ai_knowledge_chunks")
        .update({ [column]: vectors[index] })
        .eq("id", chunk.id);
      if (error) throw error;
      chars += chunk.content.length;
      filled += 1;
    }
    // The column was cleared of its previous owner before this run; record
    // the new one as soon as vectors exist, exactly as ingest does, or the
    // ladder would keep treating a populated column as free for any model.
    if (!ownershipClaimed) {
      await claimEmbeddingColumnOwnership(admin, dual);
      ownershipClaimed = true;
    }
    console.log(`filled ${filled} chunks, ${chars} chars so far`);
    // Spread this batch's characters over its share of the minute, minus the
    // time the batch already took.
    const pauseMs = (batchChars / charsPerMinute) * 60_000 - (Date.now() - startedAt);
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}
console.log(`done: ${filled} chunks filled, ${chars} chars embedded${chars >= maxChars ? " (stopped at BACKFILL_MAX_CHARS)" : ""}`);
