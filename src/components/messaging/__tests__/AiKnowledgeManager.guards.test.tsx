import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// AiKnowledgeManager is the second writer of ai_agent_configs and shipped with
// strictly weaker checks than the settings form: no error check, and a Save
// enabled over an empty textarea whose ingest deletes the source. Being the
// quieter surface is why nobody noticed.

const upsertConfig = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
const invoke = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
let configValue: unknown = null;
let configError: unknown = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: configValue, error: configError, upsertConfig }),
}));
vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: [],
    links: [],
    isLoading: false,
    graphExport: { data: null },
    invoke,
    resolveExportUrls: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/hooks/useWhatsAppCatalog", () => ({
  useWhatsAppCatalog: () => ({ waAccount: null, catalog: null }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: [] }) }));

import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";

const saveButton = () => screen.getByRole("button", { name: /save & index/i });
const box = () => screen.getByPlaceholderText(/describe your business/i);

describe("AiKnowledgeManager write guards", () => {
  beforeEach(() => {
    upsertConfig.mutateAsync.mockClear();
    configValue = null;
    configError = null;
  });

  it("refuses to save while the read is unsettled", () => {
    configValue = undefined;
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).toBeDisabled();
  });

  it("refuses to save when the read errored", () => {
    // React Query keeps the previous account's data through a failed refetch, so
    // `config` alone can be another account's profile while THIS read failed.
    configValue = { business_profile_text: "Some other account's profile" };
    configError = new Error("statement timeout");
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).toBeDisabled();
  });

  it("declares an empty profile over a stored one as a deliberate clear", () => {
    configValue = { business_profile_text: "We sell day-old chicks." };
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);

    // fireEvent.change, NOT `box().value = ""`. Assigning to .value mutates the
    // DOM node without notifying React, so `profile` state would keep the stored
    // text and this test would pass whatever the implementation did.
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.click(saveButton());

    expect(upsertConfig.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ business_profile_text: "", confirm_clear: true }),
    );
  });

  it("does not declare a clear when nothing was stored", () => {
    // A first save with an empty box is not a deletion, and marking it as one
    // would train the guard to be ignored.
    configValue = { business_profile_text: "" };
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    fireEvent.click(saveButton());

    expect(upsertConfig.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ confirm_clear: undefined }),
    );
  });

  it("allows a first save when nothing is stored yet", () => {
    configValue = null;
    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    expect(saveButton()).not.toBeDisabled();
  });
});
