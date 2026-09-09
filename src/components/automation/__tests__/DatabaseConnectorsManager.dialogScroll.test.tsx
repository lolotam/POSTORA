import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentTool } from "@/hooks/useAiAgentTools";

// The connector dialog caps its height at the viewport and scrolls only the
// form body, so the footer buttons stay reachable on tall presets (Supabase)
// while short presets render with no scrollbar. jsdom has no layout, so these
// tests assert the structural contract that makes that behaviour possible:
// a capped non-scrolling dialog column, exactly one shrinking scroll region
// between header and footer, and the footer outside that region.

const upsertTool = { mutate: vi.fn(), isPending: false };
const deleteTool = { mutate: vi.fn(), isPending: false };
let tools: AiAgentTool[] = [];
let links: Array<{ tool_id: string; social_account_id: string }> = [];
const setToolAccounts = { mutateAsync: vi.fn().mockResolvedValue({}) };
const { callEdgeApi } = vi.hoisted(() => ({ callEdgeApi: vi.fn() }));

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools, isLoading: false, upsertTool, deleteTool }),
  useAiToolAccountLinks: () => ({ links, linksReady: true, linksError: null, setToolAccounts }),
}));

vi.mock("@/lib/messagingApi", () => ({ callEdgeApi }));

const ACCOUNTS = [
  { id: "wa-1", platform: "whatsapp", platform_username: "Xsellpoint", platform_user_id: null, is_active: true },
];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: ACCOUNTS, isSuccess: true, error: null }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: { user: { id: "u1" } }, profile: { id: "u1", api_key: "pk" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn().mockResolvedValue({ data: null }) },
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DatabaseConnectorsManager platform="whatsapp" accountId="wa-1" />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const openCreateDialog = (presetCard: string) => {
  renderManager();
  fireEvent.click(screen.getByText(presetCard));
  return screen.getByRole("dialog");
};

const dialogTokens = (dialog: HTMLElement) => dialog.className.split(/\s+/);

const scrollRegions = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll(".min-h-0.overflow-y-auto"));

describe("connector dialog scroll region — normal connector form", () => {
  beforeEach(() => {
    tools = [];
    links = [];
  });

  it("caps the dialog at the viewport height without scrolling the dialog itself", () => {
    const dialog = openCreateDialog("WooCommerce Store");

    const tokens = dialogTokens(dialog);
    expect(tokens).toContain("max-h-[90vh]");
    expect(tokens).toContain("flex-col");
    expect(tokens).toContain("overflow-hidden");
    expect(tokens).not.toContain("overflow-y-auto");
    expect(tokens).not.toContain("overflow-auto");
    // DialogContent ships `grid` by default; the whole layout depends on
    // twMerge dropping it for the `flex` passed here. Without this line a
    // tailwind-merge change could silently restore display:grid, the footer
    // would leave the viewport again, and every other assertion would pass.
    expect(tokens).not.toContain("grid");
  });

  it("scrolls exactly one body region that may shrink below its content", () => {
    const dialog = openCreateDialog("WooCommerce Store");

    const regions = scrollRegions(dialog);
    expect(regions).toHaveLength(1);
    expect(regions[0].className.split(/\s+/)).toContain("min-h-0");
    expect(regions[0].className.split(/\s+/)).toContain("overflow-y-auto");
  });

  it("keeps the footer action row outside the scroll region", () => {
    const dialog = openCreateDialog("WooCommerce Store");
    const [scroll] = scrollRegions(dialog);

    const save = within(dialog).getByRole("button", { name: /save & connect/i });
    expect(scroll.contains(save)).toBe(false);
    // The region sits between header and footer in document order.
    expect(scroll.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the header outside the scroll region", () => {
    const dialog = openCreateDialog("WooCommerce Store");
    const [scroll] = scrollRegions(dialog);

    // The dialog title renders in the header; the form body repeats the
    // connector name in a plain div/span, so the heading role disambiguates.
    const title = within(dialog).getByRole("heading", { name: /WooCommerce Store/ });
    expect(scroll.contains(title)).toBe(false);
    expect(title.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("connector dialog scroll region — Higgsfield branch", () => {
  beforeEach(() => {
    tools = [];
    links = [];
  });

  it("caps the dialog at the viewport height without scrolling the dialog itself", () => {
    const dialog = openCreateDialog("Higgsfield AI Studio");

    const tokens = dialogTokens(dialog);
    expect(tokens).toContain("max-h-[90vh]");
    expect(tokens).toContain("flex-col");
    expect(tokens).toContain("overflow-hidden");
    expect(tokens).not.toContain("overflow-y-auto");
    expect(tokens).not.toContain("overflow-auto");
    // DialogContent ships `grid` by default; the whole layout depends on
    // twMerge dropping it for the `flex` passed here. Without this line a
    // tailwind-merge change could silently restore display:grid, the footer
    // would leave the viewport again, and every other assertion would pass.
    expect(tokens).not.toContain("grid");
  });

  it("scrolls exactly one body region that may shrink below its content", () => {
    const dialog = openCreateDialog("Higgsfield AI Studio");

    const regions = scrollRegions(dialog);
    expect(regions).toHaveLength(1);
    expect(regions[0].className.split(/\s+/)).toContain("min-h-0");
    expect(regions[0].className.split(/\s+/)).toContain("overflow-y-auto");
  });

  it("keeps the footer action row outside the scroll region", () => {
    const dialog = openCreateDialog("Higgsfield AI Studio");
    const [scroll] = scrollRegions(dialog);

    const connect = within(dialog).getByRole("button", { name: /connect with higgsfield/i });
    expect(scroll.contains(connect)).toBe(false);
    expect(scroll.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the header outside the scroll region", () => {
    const dialog = openCreateDialog("Higgsfield AI Studio");
    const [scroll] = scrollRegions(dialog);

    const title = within(dialog).getByRole("heading", { name: /Higgsfield AI Studio/ });
    expect(scroll.contains(title)).toBe(false);
    expect(title.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
