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

  it("offers the three input methods", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByRole("tab", { name: /manual/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /upload/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /website/i })).toBeInTheDocument();
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
});
