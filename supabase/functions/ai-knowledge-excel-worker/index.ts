import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { chunkRows, rowToText, type KnowledgeChunk } from "../ai-knowledge-ingest/chunking.ts";

const CLOUDINARY_CDN_PREFIX = "https://res.cloudinary.com/";
const EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMENSIONS = 1536;
const POLL_MS = 15_000;

type Source = {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseExcelChunks(bytes: ArrayBuffer): KnowledgeChunk[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const rows: Array<{ text: string; sheet: string; row: number }> = [];
  for (const sheet of workbook.SheetNames) {
    XLSX.utils
      .sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheet], { defval: "" })
      .forEach((row, index) => rows.push({ text: rowToText(row), sheet, row: index + 2 }));
  }
  return chunkRows(rows);
}

async function embed(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!key) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured; knowledge cannot be indexed.");
  const embeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += 64) {
    const response = await fetch(EMBED_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: texts.slice(index, index + 64),
        dimensions: EMBED_DIMENSIONS,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Embedding request failed");
    embeddings.push(...payload.data.map((item: { embedding: number[] }) => item.embedding));
  }
  return embeddings;
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

async function processSource(admin: any, source: Source) {
  try {
    const file = await downloadSource(admin, source.file_path);
    const chunks = parseExcelChunks(await file.arrayBuffer());
    if (!chunks.length) throw new Error("The workbook contains no indexable rows");
    const embeddings = await embed(chunks.map((chunk) => chunk.content));
    const { error: deleteError } = await admin.from("ai_knowledge_chunks").delete().eq("source_id", source.id);
    if (deleteError) throw deleteError;
    const { error: insertError } = await admin.from("ai_knowledge_chunks").insert(
      chunks.map((chunk, index) => ({
        source_id: source.id,
        user_id: source.user_id,
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: embeddings[index],
      })),
    );
    if (insertError) throw insertError;
    const { error: updateError } = await admin
      .from("ai_knowledge_sources")
      .update({ status: "ready", chunk_count: chunks.length, error: null })
      .eq("id", source.id);
    if (updateError) throw updateError;
    console.log(`[ai-knowledge-excel-worker] ready source=${source.id} chunks=${chunks.length}`);
  } catch (error) {
    const detail = message(error).slice(0, 500);
    await admin.from("ai_knowledge_sources").update({ status: "failed", error: detail }).eq("id", source.id);
    console.error(`[ai-knowledge-excel-worker] failed source=${source.id}: ${detail}`);
  }
}

async function runOnce(admin: any) {
  const { data, error } = await admin.rpc("claim_ai_knowledge_excel_source");
  if (error) throw error;
  const source = Array.isArray(data) ? data[0] : data;
  if (source) await processSource(admin, source as Source);
}

if (import.meta.main) {
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
}
