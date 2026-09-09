import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The true indexing date is the newest chunk's created_at, flattened to
// `indexed_at` by the hook — never updated_at, which a sharing toggle also
// advances without embedding anything. The badge renders only for ready
// sources with a present date, guarding null BEFORE constructing a Date:
// new Date(null) is the Unix epoch, not an Invalid Date, so a naive guard
// renders January 1970.

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const { callAiKnowledgeApi } = vi.hoisted(() => ({ callAiKnowledgeApi: vi.fn() }));
vi.mock("@/lib/aiKnowledgeApi", () => ({ callAiKnowledgeApi }));

// The sources query embeds one newest chunk per row; the links and export
// queries ride the same client, so the fake answers per table.
let sourceRows: Record<string, unknown>[] = [];
function tableResult(table: string) {
  if (table === "ai_knowledge_sources") return { data: sourceRows, error: null };
  if (table === "ai_knowledge_graph_exports") return { data: null, error: null };
  return { data: [], error: null };
}
const chain = (table: string): Record<string, (...args: never[]) => unknown> => ({
  select: () => chain(table),
  order: () => chain(table),
  limit: () => Promise.resolve(tableResult(table)),
  eq: () => chain(table),
  maybeSingle: () => Promise.resolve(tableResult(table)),
  then: (onFulfilled: never, onRejected: never) =>
    Promise.resolve(tableResult(table)).then(onFulfilled, onRejected),
});
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => chain(table) },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useAiKnowledge, type AiKnowledgeSource } from "@/hooks/useAiKnowledge";
import { KnowledgeSourcesPanel } from "@/components/messaging/knowledge/KnowledgeSourcesPanel";

const INDEXED_AT = "2026-08-20T12:34:56.000Z";

const source = (overrides: Partial<AiKnowledgeSource> = {}): AiKnowledgeSource => ({
  id: "s1",
  file_name: "prices.csv",
  file_path: "u1/prices.csv",
  source_type: "csv",
  status: "ready",
  error: null,
  chunk_count: 12,
  visibility: "restricted",
  created_at: "2026-08-01T00:00:00.000Z",
  indexed_at: INDEXED_AT,
  ...overrides,
});

function renderPanel(sources: AiKnowledgeSource[]) {
  return render(
    <KnowledgeSourcesPanel
      sources={sources}
      allSourcesCount={sources.length}
      isLoading={false}
      linksError={null}
      accountsError={null}
      linksReady
      accountsReady
      shareAccounts={[]}
      sharedBySource={new Map()}
      sharingSourceIds={[]}
      socialAccounts={[]}
      busy={false}
      onReingest={vi.fn()}
      onDelete={vi.fn()}
      onToggleShare={vi.fn()}
    />,
  );
}

describe("KnowledgeSourcesPanel indexed date badge", () => {
  beforeEach(() => {
    sourceRows = [];
  });

  it("renders the indexed date for a ready source with a full timestamp as title", () => {
    renderPanel([source()]);

    const badge = screen.getByText(/Indexed /);
    expect(badge.textContent).toContain(new Date(INDEXED_AT).toLocaleDateString());
    expect(badge.closest("[title]")?.getAttribute("title")).toBe(
      new Date(INDEXED_AT).toLocaleString(),
    );
  });

  it("renders no date for a pending source", () => {
    renderPanel([source({ status: "pending", chunk_count: 3 })]);

    expect(screen.queryByText(/Indexed/)).toBeNull();
  });

  it("renders no date for a failed source", () => {
    renderPanel([source({ status: "failed", error: "ingest exploded" })]);

    expect(screen.queryByText(/Indexed/)).toBeNull();
    // The failure itself is still reported; only the date is withheld.
    expect(screen.getByText("ingest exploded")).toBeInTheDocument();
  });

  it("renders no date when indexed_at is null", () => {
    renderPanel([source({ indexed_at: null })]);

    expect(screen.queryByText(/Indexed/)).toBeNull();
  });

  it("renders no date — and no 1970 or Invalid Date — when indexed_at is empty", () => {
    // new Date("") is Invalid Date and new Date(null) is the Unix epoch, so a
    // guard placed after construction renders one of these two lies.
    renderPanel([source({ indexed_at: "" })]);

    expect(screen.queryByText(/Indexed/)).toBeNull();
    expect(screen.queryByText(/1970/)).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});

describe("useAiKnowledge indexed_at flattening", () => {
  beforeEach(() => {
    sourceRows = [];
    callAiKnowledgeApi.mockReset();
  });

  it("flattens the newest chunk to indexed_at without leaking the chunk array", async () => {
    sourceRows = [
      {
        id: "s1",
        file_name: "prices.csv",
        status: "ready",
        ai_knowledge_chunks: [
          { created_at: "2026-08-20T12:34:56.000Z" },
          { created_at: "2026-08-19T09:00:00.000Z" },
        ],
      },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAiKnowledge(), { wrapper });

    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    const [row] = result.current.sources;
    expect(row.indexed_at).toBe("2026-08-20T12:34:56.000Z");
    expect("ai_knowledge_chunks" in row).toBe(false);
  });
});
