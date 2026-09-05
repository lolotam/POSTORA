import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The three input methods are tabs, but the sources list is NOT one of them.
// What the agent can actually read is the answer to "did that work", and it is
// the same answer whichever way the source got there -- so it stays mounted
// while the method above it changes.

const upsertConfig = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
const invoke = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
let configValue: unknown = null;
let configError: unknown = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: configValue, error: configError, upsertConfig }),
}));

let knowledge = {
  sources: [] as Record<string, unknown>[],
  links: [] as Record<string, unknown>[],
  linksReady: true,
  linksError: null as unknown,
};

vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: knowledge.sources,
    links: knowledge.links,
    linksReady: knowledge.linksReady,
    linksError: knowledge.linksError,
    isLoading: false,
    graphExport: null,
    invoke,
    resolveExportUrls: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/hooks/useWhatsAppCatalog", () => ({
  useWhatsAppCatalog: () => ({ waAccount: null, catalog: null }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [], isSuccess: true, error: null }),
}));

import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";

// Radix activates a tab from mousedown, not click, so a bare fireEvent.click
// leaves the panel unchanged and every assertion after it silently tests the
// first tab again.
const selectTab = (name: RegExp) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

describe("AiKnowledgeManager input methods", () => {
  beforeEach(() => {
    upsertConfig.mutateAsync.mockClear();
    invoke.mutateAsync.mockClear();
    configValue = { business_profile_text: "we sell shoes" };
    configError = null;
    knowledge = {
      sources: [
        {
          id: "s1",
          file_name: "prices.csv",
          file_path: null,
          source_type: "csv",
          status: "ready",
          error: null,
          chunk_count: 7,
          visibility: "shared",
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
      links: [],
      linksReady: true,
      linksError: null,
    };
  });

  it("keeps the sources panel visible on every input method", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByText("prices.csv")).toBeInTheDocument();

    selectTab(/upload/i);
    expect(screen.getByText("prices.csv")).toBeInTheDocument();

    selectTab(/website/i);
    expect(screen.getByText("prices.csv")).toBeInTheDocument();
  });

  it("shows the business profile only on the manual method", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByPlaceholderText(/describe your business/i)).toBeInTheDocument();

    selectTab(/upload/i);
    expect(screen.queryByPlaceholderText(/describe your business/i)).not.toBeInTheDocument();
  });

  it("shows the upload control only on the upload method", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.queryByText(/^Upload file$/)).not.toBeInTheDocument();

    selectTab(/upload/i);
    expect(screen.getByText(/^Upload file$/)).toBeInTheDocument();
  });
  it("does not offer re-ingest on a website source", () => {
    // Codex P2. ingest_source accepts only the uploaded file types, so the
    // refresh button on a website row would return "Source type not supported".
    knowledge.sources = [
      {
        id: "w1",
        file_name: "x.com (whole site)",
        file_path: "https://x.com",
        source_type: "website",
        status: "ready",
        error: null,
        chunk_count: 12,
        visibility: "shared",
        metadata: { url: "https://x.com", mode: "site" },
        created_at: "2026-09-05T00:00:00Z",
      },
    ];
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByRole("button", { name: /re-ingest source/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /delete source/i })).toBeEnabled();
  });

  it("shows the crawl checklist while a website source is still working", () => {
    knowledge.sources = [
      {
        id: "w2",
        file_name: "x.com (whole site)",
        file_path: "https://x.com",
        source_type: "website",
        status: "pending",
        error: null,
        chunk_count: 0,
        visibility: "shared",
        metadata: { url: "https://x.com", mode: "site", stage: "crawling", pages_done: 3, pages_total: 9 },
        created_at: "2026-09-05T00:00:00Z",
      },
    ];
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByText(/reading pages \(3\/9\)/i)).toBeInTheDocument();
    expect(screen.getByText(/indexing into the vector database/i)).toBeInTheDocument();
  });

  it("shows the running chunk count while a large file is still being indexed", () => {
    // A 50-chunk document is indexed in slices over several minutes and is
    // `pending` between slices; without the count the badge read as a stuck
    // upload (2026-09-05 report).
    knowledge.sources = [
      {
        id: "d1",
        file_name: "handbook.md",
        file_path: "supabase://ai-knowledge/u1/sources/handbook.md",
        source_type: "doc",
        status: "pending",
        error: null,
        chunk_count: 24,
        visibility: "shared",
        metadata: {},
        created_at: "2026-09-05T00:00:00Z",
      },
    ];
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByText(/pending · 24 chunks so far/i)).toBeInTheDocument();
  });
});
