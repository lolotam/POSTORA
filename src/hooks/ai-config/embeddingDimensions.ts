import type { AIModel } from './types';

/**
 * ai_knowledge_chunks has exactly two vector columns — embedding vector(1536)
 * and embedding_bge_m3 vector(1024) — so an embedding model is only selectable
 * when Postora can request one of those widths. Mirrors
 * STORABLE_EMBEDDING_DIMENSIONS in supabase/functions/_shared/knowledgeEmbeddings.ts.
 */
export const STORABLE_EMBEDDING_WIDTHS = [1024, 1536] as const;

/**
 * Width Postora would actually request from the model: the requested dimension
 * when the model supports one (metadata.embedding_dimensions.requested), else
 * the native width. Null when the catalog row carries no dimensionality record.
 */
export function recordedEmbeddingWidth(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  const dims = metadata?.embedding_dimensions;
  if (!dims || typeof dims !== 'object') return null;
  const record = dims as { native?: unknown; requested?: unknown };
  const width = typeof record.requested === 'number' ? record.requested : record.native;
  return typeof width === 'number' ? width : null;
}

/**
 * Disable reason for an embedding model the admin can see but must not select,
 * or null when the model is storable. Unusable models stay visible so the
 * catalog is honest, but are never silently selectable.
 */
export function embeddingModelNote(model: AIModel): string | null {
  const width = recordedEmbeddingWidth(model.metadata);
  if (width === null) return 'unknown vector width';
  return (STORABLE_EMBEDDING_WIDTHS as readonly number[]).includes(width)
    ? null
    : `${width}-d vectors have no column`;
}
