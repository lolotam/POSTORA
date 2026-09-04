import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The page gates itself on the flag, and useFeatureFlags reads useAuth.
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { audienceHub: true }, isLoading: false }),
}));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const useSocialContacts = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return {
    ...actual,
    useSocialContacts: (...a: unknown[]) => useSocialContacts(...a),
    useSocialContactStats: () => ({ data: { total: 2, workflow_leads: 1, enriched: 1, top_platform: "instagram" } }),
    useSocialContactTags: () => ({ data: ["lead"] }),
    useUpdateSocialContact: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteSocialContact: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import AudiencePage from "@/pages/automation/AudiencePage";

const rows = [
  { id: "1", platform: "instagram", display_name: "Dana", username: "dana.kw", platform_user_id: "178", email: null, phone_number: null,
    source: "organic_comment", tags: ["lead"], total_comments_count: 3, last_interacted_at: new Date().toISOString(), whatsapp_contact_id: null },
  { id: "2", platform: "threads", display_name: "", username: "vigrox.kw", platform_user_id: "vigrox.kw", email: "v@x.io", phone_number: null,
    source: "workflow_lead", tags: [], total_comments_count: 1, last_interacted_at: new Date().toISOString(), whatsapp_contact_id: null },
];

describe("AudiencePage", () => {
  it("renders KPIs and one row per contact", () => {
    useSocialContacts.mockReturnValue({ data: { rows, total: 2 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText("Audience & Contacts")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-Workflow leads")).toHaveTextContent("1");
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.getByText("vigrox.kw")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
  });

  it("pages forward and back", () => {
    useSocialContacts.mockReturnValue({ data: { rows, total: 120 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useSocialContacts).toHaveBeenLastCalledWith(expect.anything(), 1);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(useSocialContacts).toHaveBeenLastCalledWith(expect.anything(), 0);
  });

  // Changing a filter while deep in the results must not leave the viewer on a
  // page the new result set no longer has.
  it("passes the search term to the hook and resets to page 0", () => {
    useSocialContacts.mockReturnValue({ data: { rows, total: 120 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useSocialContacts).toHaveBeenLastCalledWith(expect.anything(), 1);
    fireEvent.change(screen.getByPlaceholderText("Search name, handle, phone or email"), { target: { value: "dana" } });
    expect(useSocialContacts).toHaveBeenLastCalledWith(expect.objectContaining({ search: "dana" }), 0);
  });

  it("shows the empty state when there are no contacts", () => {
    useSocialContacts.mockReturnValue({ data: { rows: [], total: 0 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText("No contacts yet")).toBeInTheDocument();
  });

  // A failed read and an empty tenant look identical to a viewer unless the page
  // says so, which would hide a bad deploy behind a plausible empty state.
  it("shows the failure, not the empty state, when the query errors", () => {
    useSocialContacts.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("permission denied for function search_social_contacts"),
    });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText(/Could not load contacts/)).toBeInTheDocument();
    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
    expect(screen.queryByText("No contacts yet")).not.toBeInTheDocument();
  });
});
