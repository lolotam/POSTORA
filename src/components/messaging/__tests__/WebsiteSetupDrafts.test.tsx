import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AiAgentConfig } from "@/hooks/useAiAgentConfig";
import type { WebsiteSetupJob } from "@/lib/websiteSetup";

const edgeApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/messagingApi", () => ({ callEdgeApi: edgeApi }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
let loadError: Error | null = null;
let jobs: WebsiteSetupJob[];
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { WebsiteSetupDrafts } from "@/components/messaging/knowledge/WebsiteSetupDrafts";

const config = { updated_at: "2026-09-06T12:00:00Z", agent_behavior: { tone: "concise" } } as AiAgentConfig;
const props = {
  platform: "threads" as const, accountId: "account-a", sources: [], config, configError: null,
  profile: { products: "Existing catalog" }, profileDirty: false,
};

function renderDraft(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(children, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadError = null;
  edgeApi.mockImplementation(async (_endpoint, action, body) => {
    if (action === "list") {
      if (loadError) throw loadError;
      return { jobs: jobs.filter((job) => job.social_account_id === body.social_account_id) };
    }
    return { profile_indexing: { status: "ready" } };
  });
  jobs = [{
    id: "job-a", source_id: "source-a", social_account_id: "account-a", platform: "threads", status: "ready", error: null,
    created_at: "2026-09-06T13:00:00Z", updated_at: "2026-09-06T13:00:05Z",
    result: {
      business_profile: { products: "Generated catalog", policies: { returns: "14 days" } },
      agent_behavior: { tone: "formal", greeting: "Welcome to our store" },
      evidence: { "business_profile.policies.returns": ["https://example.com/returns"] },
      coverage: { mode: "page", pages: 1, truncated: false },
    },
  }];
});

const openReview = async () => fireEvent.click(await screen.findByRole("button", { name: /review generated/i }));

describe("website setup review", () => {
  it("preserves existing fields and applies new fields with the reviewed version", async () => {
    renderDraft(<WebsiteSetupDrafts {...props} />);
    await openReview();
    expect(screen.getByRole("checkbox", { name: "Products and services" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /tone of voice/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Returns policy" })).toBeChecked();
    expect(screen.getByRole("link", { name: "https://example.com/returns" })).toHaveAttribute("href", "https://example.com/returns");
    fireEvent.click(screen.getByRole("button", { name: /apply selected/i }));
    await waitFor(() => expect(edgeApi).toHaveBeenCalledWith("ai-website-setup", "apply", {
      job_id: "job-a", fields: ["business_profile.policies.returns", "agent_behavior.greeting"],
      expected_config_updated_at: config.updated_at,
    }));
  });

  it("requires explicit selection to replace an existing value", async () => {
    renderDraft(<WebsiteSetupDrafts {...props} />);
    await openReview();
    fireEvent.click(screen.getByRole("checkbox", { name: "Products and services" }));
    fireEvent.click(screen.getByRole("button", { name: /apply selected/i }));
    await waitFor(() => expect(edgeApi).toHaveBeenCalledWith("ai-website-setup", "apply", expect.objectContaining({
      fields: expect.arrayContaining(["business_profile.products"]),
    })));
  });

  it("blocks application after a concurrent settings update", async () => {
    const view = renderDraft(<WebsiteSetupDrafts {...props} />);
    await openReview();
    view.rerender(<WebsiteSetupDrafts {...props} config={{ ...config, updated_at: "2026-09-06T14:00:00Z" }} />);
    expect(screen.getByRole("button", { name: /apply selected/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/settings changed/i);
  });

  it("blocks application over manual edits or a failed config read", async () => {
    const view = renderDraft(<WebsiteSetupDrafts {...props} profileDirty />);
    await openReview();
    expect(screen.getByRole("button", { name: /apply selected/i })).toBeDisabled();
    view.rerender(<WebsiteSetupDrafts {...props} configError={new Error("timeout")} />);
    expect(screen.queryByRole("button", { name: /apply selected/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close review/i })).toBeDisabled();
  });

  it("does not display another account's draft after switching accounts", async () => {
    const view = renderDraft(<WebsiteSetupDrafts {...props} />);
    await openReview();
    view.rerender(<WebsiteSetupDrafts {...props} accountId="account-b" />);
    expect(screen.queryByText("Generated catalog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply selected/i })).not.toBeInTheDocument();
  });

  it("reports a failed draft read rather than an empty list", async () => {
    loadError = new Error("Request failed");
    renderDraft(<WebsiteSetupDrafts {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load setup drafts/i);
    expect(screen.queryByText(/no setup drafts yet/i)).not.toBeInTheDocument();
  });

  it("reports saved settings separately when profile indexing fails", async () => {
    const implementation = edgeApi.getMockImplementation()!;
    edgeApi.mockImplementation((endpoint, action, body) => action === "apply"
      ? Promise.resolve({ profile_indexing: { status: "failed" } })
      : implementation(endpoint, action, body));
    renderDraft(<WebsiteSetupDrafts {...props} />);
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: /apply selected/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/settings were saved, but profile indexing failed/i);
  });
});
