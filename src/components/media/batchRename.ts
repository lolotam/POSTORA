import { supabase } from "@/integrations/supabase/client";

export interface BatchRenameFile {
  id: string;
  file_path: string;
  cloudinary_public_id?: string;
  storage_bucket: string;
  metadata?: { original_filename?: unknown } | null;
}

type MediaFilesTable = {
  from: (table: "media_files") => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        single: () => Promise<{ data: { metadata: unknown } | null; error: { message: string } | null }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/** Supabase storage paths are the only names a rename may move. Every other bucket is a delivery URL. */
function keepsStoragePath(storageBucket: string): boolean {
  return storageBucket === "media" || storageBucket === "supabase";
}

export function batchOriginalName(file: { file_path: string; metadata?: { original_filename?: unknown } | null }): string {
  const original = file.metadata?.original_filename;
  if (typeof original === "string" && original.trim()) return original.trim();
  const leaf = file.file_path.split("/").pop() || "";
  return leaf.split("?")[0].split("#")[0];
}

export async function renameBatchFile(file: BatchRenameFile, newName: string, db?: MediaFilesTable): Promise<void> {
  const table = db ?? (supabase as unknown as MediaFilesTable);
  if (keepsStoragePath(file.storage_bucket)) {
    const pathParts = file.file_path.split("/");
    pathParts[pathParts.length - 1] = newName;
    const { error } = await table.from("media_files").update({ file_path: pathParts.join("/") }).eq("id", file.id);
    if (error) throw error;
    return;
  }

  const { data: row, error: fetchError } = await table.from("media_files").select("metadata").eq("id", file.id).single();
  if (fetchError) throw fetchError;
  const metadata = row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  const { error } = await table.from("media_files").update({ metadata: { ...metadata, original_filename: newName } }).eq("id", file.id);
  if (error) throw error;
}
