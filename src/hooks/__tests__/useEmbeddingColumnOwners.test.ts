import { describe, expect, it } from "vitest";
import { embeddingColumnForWidth, reEmbedWarningFor } from "@/hooks/useEmbeddingColumnOwners";
import type { AIModel } from "@/hooks/ai-config/types";

const PROVIDERS = [
  { id: "p-gemini", provider_code: "gemini" },
  { id: "p-openai", provider_code: "openai" },
  { id: "p-ollama", provider_code: "ollama" },
];

function model(providerId: string, modelId: string, requested: number): AIModel {
  return {
    provider_id: providerId,
    model_id: modelId,
    metadata: { embedding_dimensions: { native: requested, requested } },
  } as unknown as AIModel;
}

const MODELS = [
  model("p-gemini", "gemini-embedding-001", 1536),
  model("p-gemini", "gemini-embedding-2", 1536),
  model("p-openai", "text-embedding-3-small", 1536),
  model("p-ollama", "bge-m3:latest", 1024),
];

// Production ownership at the time of writing: 2,908 vectors from Gemini in the
// 1536 column, 61 from bge-m3 in the 1024 column.
const OWNERS = {
  embedding: { provider_code: "gemini", model_id: "gemini-embedding-001" },
  embedding_bge_m3: { provider_code: "ollama", model_id: "bge-m3:latest" },
};

describe("reEmbedWarningFor", () => {
  it("stays silent when the selection is already the column's owner", () => {
    expect(
      reEmbedWarningFor({ provider_code: "gemini", model_id: "gemini-embedding-001" }, MODELS, OWNERS, PROVIDERS),
    ).toBeNull();
  });

  it("warns for a different model at the SAME dimension", () => {
    // The case that makes this worth testing: text-embedding-3-small is also
    // 1536-d, so a width-based check would wave it through and silently destroy
    // retrieval over the existing corpus.
    const warning = reEmbedWarningFor(
      { provider_code: "openai", model_id: "text-embedding-3-small" },
      MODELS,
      OWNERS,
      PROVIDERS,
    );
    expect(warning).toContain("gemini/gemini-embedding-001");
    expect(warning).toContain("Same dimension does not mean compatible");
  });

  it("warns when switching between two models of the same provider", () => {
    expect(
      reEmbedWarningFor({ provider_code: "gemini", model_id: "gemini-embedding-2" }, MODELS, OWNERS, PROVIDERS),
    ).not.toBeNull();
  });

  it("stays silent for a column that has no recorded owner yet", () => {
    expect(
      reEmbedWarningFor(
        { provider_code: "ollama", model_id: "bge-m3:latest" },
        MODELS,
        { embedding: OWNERS.embedding },
        PROVIDERS,
      ),
    ).toBeNull();
  });

  it("stays silent for a model whose width is unknown", () => {
    // Nothing can be claimed about a model with no recorded dimensionality, and
    // inventing a warning would train the admin to click through them.
    const unknown = [{ provider_id: "p-openai", model_id: "mystery", metadata: {} } as unknown as AIModel];
    expect(
      reEmbedWarningFor({ provider_code: "openai", model_id: "mystery" }, unknown, OWNERS, PROVIDERS),
    ).toBeNull();
  });

  it("does not confuse two providers exposing the same model slug", () => {
    const shared = [
      model("p-openai", "text-embedding-3-small", 1536),
      model("p-gemini", "text-embedding-3-small", 1024),
    ];
    // Resolved through provider_id, so this picks the 1024 row and compares it
    // against the bge-m3 owner rather than the Gemini one.
    const warning = reEmbedWarningFor(
      { provider_code: "gemini", model_id: "text-embedding-3-small" },
      shared,
      OWNERS,
      PROVIDERS,
    );
    expect(warning).toContain("ollama/bge-m3:latest");
  });
});

describe("embeddingColumnForWidth", () => {
  it.each([
    [1024, "embedding_bge_m3"],
    [1536, "embedding"],
  ])("maps %i to %s", (width, column) => {
    expect(embeddingColumnForWidth(width)).toBe(column);
  });
});
