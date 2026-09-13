import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeSourcesPanel } from "@/components/messaging/knowledge/KnowledgeSourcesPanel";
import type { AiKnowledgeSource } from "@/hooks/useAiKnowledge";

// Renaming is a label change, never an identity change: the panel sends the
// trimmed new name once, on Save, and nothing on Cancel or on an unchanged name.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function source(overrides: Partial<AiKnowledgeSource> = {}): AiKnowledgeSource {
  return {
    id: "s1",
    file_name: "Business profile · danantfuture (whatsapp)",
    file_path: null,
    source_type: "profile_text",
    status: "ready",
    error: null,
    chunk_count: 3,
    visibility: "restricted",
    metadata: { profile_account_id: "acct-1" },
    created_at: "2026-09-13T00:00:00Z",
    indexed_at: "2026-09-13T00:00:00Z",
    ...overrides,
  };
}

function renderPanel(sources: AiKnowledgeSource[], onRename = vi.fn()) {
  render(
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
      onRename={onRename}
      onToggleShare={vi.fn()}
    />,
  );
  return onRename;
}

describe("KnowledgeSourcesPanel rename", () => {
  it("offers a rename on every source and sends the trimmed name on Save", () => {
    const onRename = renderPanel([source(), source({ id: "s2", file_name: "prices.xlsx", source_type: "excel" })]);
    expect(screen.getAllByRole("button", { name: "Rename source" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Rename source" })[1]);
    const input = screen.getByLabelText("Source name") as HTMLInputElement;
    expect(input.value).toBe("prices.xlsx");
    fireEvent.change(input, { target: { value: "  Price list   2026 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][0].id).toBe("s2");
    expect(onRename.mock.calls[0][1]).toBe("Price list 2026");
    expect(screen.queryByLabelText("Source name")).not.toBeInTheDocument();
  });

  it("sends nothing on Cancel, on Escape, or when the name did not change", () => {
    const onRename = renderPanel([source()]);
    fireEvent.click(screen.getByRole("button", { name: "Rename source" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(screen.queryByLabelText("Source name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename source" }));
    fireEvent.keyDown(screen.getByLabelText("Source name"), { key: "Escape" });
    expect(screen.queryByLabelText("Source name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename source" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRename).not.toHaveBeenCalled();
  });
});
