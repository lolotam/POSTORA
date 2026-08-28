import { describe, expect, it } from 'vitest';
import { embeddingModelNote, recordedEmbeddingWidth } from '@/hooks/ai-config/embeddingDimensions';
import type { AIModel } from '@/hooks/ai-config/types';

function modelWithMetadata(metadata: Record<string, unknown> | null): AIModel {
  return {
    id: 'm1',
    provider_id: 'p1',
    model_id: 'bge-m3:latest',
    name: 'BGE-M3',
    description: null,
    capabilities: ['embedding'],
    context_limit: null,
    is_active: true,
    cost_per_1m_input_tokens: null,
    cost_per_1m_output_tokens: null,
    metadata,
  };
}

describe('recordedEmbeddingWidth', () => {
  it.each([
    ['uses the requested width when present', { embedding_dimensions: { native: 3072, requested: 1536 } }, 1536],
    ['falls back to the native width', { embedding_dimensions: { native: 1024, requested: 1024 } }, 1024],
  ])('%s', (_name, metadata, expected) => {
    expect(recordedEmbeddingWidth(metadata)).toBe(expected);
  });

  it('returns null when no dimensionality is recorded', () => {
    expect(recordedEmbeddingWidth({})).toBeNull();
    expect(recordedEmbeddingWidth(null)).toBeNull();
    expect(recordedEmbeddingWidth(undefined)).toBeNull();
    expect(recordedEmbeddingWidth({ embedding_dimensions: 'broken' })).toBeNull();
  });
});

describe('embeddingModelNote', () => {
  it.each([
    ['1536 requested is storable', { embedding_dimensions: { native: 3072, requested: 1536 } }, null],
    ['1024 native is storable', { embedding_dimensions: { native: 1024, requested: 1024 } }, null],
    ['768 has no column', { embedding_dimensions: { native: 768, requested: 768 } }, '768-d vectors have no column'],
    ['missing record is unknown', {}, 'unknown vector width'],
  ])('%s', (_name, metadata, expected) => {
    expect(embeddingModelNote(modelWithMetadata(metadata))).toBe(expected);
  });
});
