import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel never signs a URL in the browser — four stored file_path formats
// exist and only the edge action's locator covers all of them. It calls the
// `download_source` action with the source id and navigates to the returned
// URL, which already carries its attachment filename.

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const { callAiKnowledgeApi } = vi.hoisted(() => ({ callAiKnowledgeApi: vi.fn() }));
vi.mock("@/lib/aiKnowledgeApi", () => ({ callAiKnowledgeApi }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) },
}));

const { errorToast } = vi.hoisted(() => ({ errorToast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: errorToast } }));

import { KnowledgeSourcesPanel } from "@/components/messaging/knowledge/KnowledgeSourcesPanel";
import type { AiKnowledgeSource } from "@/hooks/useAiKnowledge";

const assign = vi.hoisted(() => vi.fn());

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
  indexed_at: "2026-08-20T12:34:56.000Z",
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

const downloadButtons = () =>
  screen.getAllByRole("button", { name: "Download source" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KnowledgeSourcesPanel source download", () => {
  beforeEach(() => {
    callAiKnowledgeApi.mockReset();
    errorToast.mockClear();
    assign.mockClear();
    Object.defineProperty(window, "location", {
      value: { assign },
      writable: true,
      configurable: true,
    });
  });

  it("shows a download control for file-backed source types", () => {
    renderPanel(
      ["csv", "pdf", "excel", "doc", "image"].map((source_type, index) =>
        source({ id: `file-${index}`, source_type }),
      ),
    );

    expect(downloadButtons()).toHaveLength(5);
  });

  it("shows no download control for website, catalog, and profile_text sources", () => {
    renderPanel(
      ["website", "catalog", "profile_text"].map((source_type, index) =>
        source({ id: `fileless-${index}`, source_type }),
      ),
    );

    expect(screen.queryByRole("button", { name: "Download source" })).toBeNull();
  });

  it("resolves the download URL for that source id and navigates to it", async () => {
    callAiKnowledgeApi.mockResolvedValue({ url: "https://cdn.example.com/prices.csv" });
    renderPanel([source({ id: "s1" }), source({ id: "s2", file_name: "menu.pdf" })]);

    fireEvent.click(downloadButtons()[1]);

    await waitFor(() =>
      expect(callAiKnowledgeApi).toHaveBeenCalledWith("download_source", { source_id: "s2" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://cdn.example.com/prices.csv"));
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("disables only the resolving row while other rows stay interactive", async () => {
    const gate = deferred<{ url: string }>();
    callAiKnowledgeApi.mockReturnValue(gate.promise);
    renderPanel([source({ id: "s1" }), source({ id: "s2" })]);

    fireEvent.click(downloadButtons()[0]);

    const [first, second] = downloadButtons();
    expect(first).toBeDisabled();
    expect(second).toBeEnabled();

    gate.resolve({ url: "https://cdn.example.com/prices.csv" });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Download source" })[0]).toBeEnabled());
  });

  it("surfaces a visible error and re-enables the row when the download fails", async () => {
    callAiKnowledgeApi.mockRejectedValue(new Error("Download link is unavailable"));
    renderPanel([source({ id: "s1" })]);

    fireEvent.click(downloadButtons()[0]);

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("Download link is unavailable"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download source" })).toBeEnabled(),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("exposes the control as a labelled button", () => {
    renderPanel([source()]);

    const control = screen.getByRole("button", { name: "Download source" });
    expect(control.tagName).toBe("BUTTON");
    expect(control).toHaveAttribute("aria-label", "Download source");
    expect(control).toBeEnabled();
  });
});
