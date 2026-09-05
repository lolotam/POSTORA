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
//   docker exec -e BACKFILL_COLUMN=embedding_bge_m3 -e BACKFILL_MAX_CHARS=2500000 <worker> \
//     deno run --allow-env --allow-net --allow-read /tmp/backfill.ts
//
// BACKFILL_MAX_CHARS caps the run so a metered provider's monthly allowance
// is not spent in one go; rerun later to continue where it stopped. Chunks
// belonging to users with an agent switched on are filled first, so the
// accounts that actually retrieve get their failover vectors before idle ones.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import {
  type EmbeddingConfig,
  embedKnowledge,
  resolveDualEmbeddingConfigFromDb,
} from "/home/deno/functions/_shared/knowledgeEmbeddings.ts";

const BATCH = 64;

const url = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const column = parseColumn(Deno.env.get("BACKFILL_COLUMN"));

function parseColumn(value: string | undefined): EmbeddingConfig["column"] {
  if (value === "embedding" || value === "embedding_bge_m3") return value;
  throw new Error("BACKFILL_COLUMN must be embedding or embedding_bge_m3");
}
const maxChars = Number(Deno.env.get("BACKFILL_MAX_CHARS") ?? Number.POSITIVE_INFINITY);

const admin = createClient(url, serviceKey);

const dual = await resolveDualEmbeddingConfigFromDb(admin);
const config: EmbeddingConfig | null = [dual.primary, dual.fallback].find(
  (tier) => tier?.column === column,
) ?? null;
if (!config) throw new Error(`The admin ladder assigns no model to ${column}; nothing to backfill with`);
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

let chars = 0;
let filled = 0;
for (const scope of [priorityUsers.length ? priorityUsers : null, null]) {
  while (chars < maxChars) {
    const batch = await nextBatch(scope);
    if (!batch.length) break;
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
    console.log(`filled ${filled} chunks, ${chars} chars so far`);
  }
}
console.log(`done: ${filled} chunks filled, ${chars} chars embedded${chars >= maxChars ? " (stopped at BACKFILL_MAX_CHARS)" : ""}`);
