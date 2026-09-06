import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Manual tab writes STRUCTURE. business_profile_text is derived from it by
// the server, so nothing here may send that column -- two writers of one
// derived value is how the jsonb and the indexed text drift apart.

const upsertConfig = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
const invoke = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
let configValue: unknown = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: configValue, error: null, upsertConfig }),
}));
vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: [],
    links: [],
    linksReady: true,
    linksError: null,
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
import { renderBusinessProfileText } from "@/lib/agentProfile";

const save = () => screen.getByRole("button", { name: /save & index/i });
const lastPayload = () =>
  (upsertConfig.mutateAsync.mock.calls.at(-1) as [Record<string, unknown>])[0];

describe("AiKnowledgeManager structured profile", () => {
  beforeEach(() => {
    upsertConfig.mutateAsync.mockClear();
    invoke.mutateAsync.mockClear();
    configValue = {
      business_profile: { products: "shoes" },
      // Derived from the structure, exactly as the server stores it. A fixture
      // where the two disagree would trip the rollout-divergence fallback and
      // test that instead of the round-trip this case is about.
      business_profile_text: renderBusinessProfileText({ products: "shoes" }),
    };
  });

  it("opens pre-filled from the stored structure", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect((screen.getByLabelText(/products and services/i) as HTMLTextAreaElement).value).toBe(
      "shoes",
    );
  });

  it("preserves manual edits when a website draft save refreshes the config", () => {
    const view = render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    fireEvent.change(screen.getByLabelText(/products and services/i), { target: { value: "My newer edits" } });
    configValue = {
      business_profile: { products: "Website generated catalog", policies: { returns: "14 days" } },
      business_profile_text: renderBusinessProfileText({ products: "Website generated catalog", policies: { returns: "14 days" } }),
    };
    view.rerender(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(screen.getByLabelText(/products and services/i)).toHaveValue("My newer edits");
    expect(screen.getByLabelText(/returns policy/i)).toHaveValue("14 days");
    fireEvent.click(save());
    expect(lastPayload().business_profile).toEqual(expect.objectContaining({ products: "My newer edits", policies: expect.objectContaining({ returns: "14 days" }) }));
    view.rerender(<AiKnowledgeManager platform="facebook" accountId="a2" />);
    expect(screen.getByLabelText(/products and services/i)).toHaveValue("Website generated catalog");
  });

  it("saves the edited structure, never the derived text", () => {
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

    fireEvent.change(screen.getByLabelText(/products and services/i), {
      target: { value: "shoes and bags" },
    });
    fireEvent.change(screen.getByLabelText(/returns policy/i), { target: { value: "14 days" } });
    fireEvent.click(save());

    expect(lastPayload().business_profile).toEqual({
      products: "shoes and bags",
      policies: { returns: "14 days" },
    });
    expect("business_profile_text" in lastPayload()).toBe(false);
  });

  it("keeps each FAQ as a separate question and answer", () => {
    configValue = { business_profile: {}, business_profile_text: "" };
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

    fireEvent.click(screen.getByRole("button", { name: /add a question/i }));
    fireEvent.change(screen.getByLabelText("Question 1"), {
      target: { value: "Do you ship abroad?" },
    });
    fireEvent.change(screen.getByLabelText("Answer 1"), { target: { value: "GCC only." } });
    fireEvent.click(save());

    expect(lastPayload().business_profile).toEqual({
      faqs: [{ q: "Do you ship abroad?", a: "GCC only." }],
    });
  });

  it("re-indexes the profile for the selected account after saving", async () => {
    // The save and the re-index are two calls, and the second must name the
    // account -- an unscoped ingest_profile_text reads an ambiguous config and
    // its empty result DELETES the indexed source.
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    fireEvent.click(save());

    // The re-index runs only after the save resolves -- asserting synchronously
    // would pass on a build that never chained them.
    await waitFor(() =>
      expect(invoke.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ingest_profile_text",
          platform: "facebook",
          social_account_id: "a1",
        }),
      ),
    );
  });
});
