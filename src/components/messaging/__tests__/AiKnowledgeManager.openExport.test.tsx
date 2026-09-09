import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Opening a knowledge-graph export shipped with `noopener` in the window.open
// feature string. window.open returns null by specification when noopener is
// set, even though the tab opens, so the handle was always null: every click
// took the same-tab fallback and left a permanently blank second tab behind.
// Reported from production on 2026-09-09 as "it opens in the same tab, and then
// opening another tab shows nothing".

const resolveExportUrls = { mutateAsync: vi.fn(), isPending: false };
const invoke = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
// vi.mock is hoisted above the file's own consts, so the spy has to be created
// in a hoisted block or the factory reads it before initialisation.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), message: vi.fn() },
}));
vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config: null, error: null, upsertConfig: invoke }),
}));
vi.mock("@/hooks/useAiKnowledge", () => ({
  useAiKnowledge: () => ({
    user: { id: "u1" },
    sources: [],
    links: [],
    linksReady: true,
    linksError: null,
    isLoading: false,
    // The hook unwraps the query, so this is the stored row itself.
    graphExport: {
      html_url: "https://openinary.example.com/graph.html",
      vault_url: "https://openinary.example.com/vault.zip",
    },
    invoke,
    resolveExportUrls,
  }),
}));
vi.mock("@/hooks/useWhatsAppCatalog", () => ({
  useWhatsAppCatalog: () => ({ waAccount: null, catalog: null }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: [] }) }));

import { AiKnowledgeManager } from "@/components/messaging/AiKnowledgeManager";

/** Stands in for the tab the browser hands back. Records what was done to it. */
function fakeTab() {
  return {
    opener: {} as unknown,
    closed: false,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

const OPENINARY_HTML = "https://openinary.example.com/graph.html";

function openGraph() {
  fireEvent.click(screen.getByRole("button", { name: /open graph/i }));
}

describe("opening a knowledge graph export", () => {
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveExportUrls.mutateAsync.mockResolvedValue({
      html_url: OPENINARY_HTML,
      vault_url: "https://openinary.example.com/vault.zip",
    });
    assign = vi.fn();
    // The current tab must never be navigated. Spying on it is the only way to
    // catch a regression back to the same-tab fallback.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, replace: vi.fn() },
    });
  });

  it("opens exactly one new tab and points it at the export", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(OPENINARY_HTML));
    expect(open).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("does not pass noopener, which would make window.open return null", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(fakeTab() as unknown as Window);

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    // Asserting on the argument rather than the outcome because the outcome is
    // indistinguishable in jsdom: only a real browser returns null for it.
    const features = open.mock.calls[0][2];
    expect(features ?? "").not.toContain("noopener");
  });

  it("severs the opener link on the tab it hands over", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    // What `noopener` was there to do, kept without losing the handle.
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
    expect(tab.opener).toBeNull();
  });

  it("tells the user to allow pop-ups rather than navigating the current tab", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    expect(assign).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/pop-ups/i));
    // Nothing was resolved either: there is no tab to put the answer in.
    expect(resolveExportUrls.mutateAsync).not.toHaveBeenCalled();
  });

  it("closes the tab it opened when no link comes back", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    resolveExportUrls.mutateAsync.mockResolvedValue({ html_url: null, vault_url: null });

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    // A tab left sitting on about:blank is the symptom being fixed, so it must
    // not be the failure mode either.
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("closes the tab it opened when resolving throws", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    resolveExportUrls.mutateAsync.mockRejectedValue(new Error("network down"));

    render(<AiKnowledgeManager platform="facebook" accountId="a1" />);
    openGraph();

    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith("network down");
    expect(assign).not.toHaveBeenCalled();
  });
});
