import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setActive = { mutate: vi.fn() };
const remove = { mutate: vi.fn() };

const RULES = [
  {
    id: "r1",
    social_account_id: "a1",
    platform: "instagram",
    name: "Guide",
    target_post_id: "p9",
    match_type: "exact",
    keywords: ["GUIDE"],
    public_replies: ["Check your DM"],
    dm_message: "here",
    media_file_id: null,
    send_once_per_user: true,
    is_active: true,
  },
  {
    id: "r2",
    social_account_id: "a2",
    platform: "facebook",
    name: "Price",
    target_post_id: null,
    match_type: "contains",
    keywords: ["price", "cost"],
    public_replies: [],
    dm_message: "our prices",
    media_file_id: null,
    send_once_per_user: false,
    is_active: false,
  },
];

const STATS = {
  r1: {
    rule_id: "r1",
    triggered_count: 9,
    public_sent_count: 8,
    dm_sent_count: 6,
    failed_count: 1,
    indeterminate_count: 2,
    last_triggered_at: null,
  },
};

const hooks = vi.hoisted(() => ({ isError: false, statsError: false }));

vi.mock("../hooks/useCommentWorkflowRules", () => ({
  useCommentWorkflowRules: () => ({
    rules: RULES,
    isLoading: false,
    isError: hooks.isError,
    remove,
    setActive,
  }),
  useCommentWorkflowStats: () => ({ statsByRule: hooks.statsError ? {} : STATS, isLoading: false, isError: hooks.statsError }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "a1", platform: "instagram", platform_username: "shop_ig" },
      { id: "a2", platform: "facebook", platform_username: "Shop Page" },
    ],
  }),
}));

vi.mock("@/components/PlatformIcon", () => ({ PlatformIcon: () => <span /> }));

import { WorkflowPool } from "../WorkflowPool";

describe("WorkflowPool", () => {
  beforeEach(() => {
    hooks.isError = false;
    hooks.statsError = false;
    setActive.mutate.mockClear();
    remove.mutate.mockClear();
  });

  it("shows each workflow with its account, trigger and counters", () => {
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("Guide")).toBeInTheDocument();
    expect(screen.getByText(/shop_ig/)).toBeInTheDocument();
    expect(screen.getByText('Exact "GUIDE"')).toBeInTheDocument();
    expect(screen.getByLabelText("Guide: private messages sent")).toHaveTextContent("6");
    expect(screen.getByLabelText("Guide: comments claimed")).toHaveTextContent("9");
    // Price has no activity yet, and reads as zero rather than borrowing Guide's numbers.
    expect(screen.getByLabelText("Price: comments claimed")).toHaveTextContent("0");
  });

  it("keeps unconfirmed sends visibly apart from failures", () => {
    // A platform timeout is not proof of non-delivery, and showing it as "failed" would invite
    // the user to send again — which Meta refuses, once per comment.
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("2 unconfirmed")).toBeInTheDocument();
  });

  it("filters by platform", () => {
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Facebook" }));
    expect(screen.queryByText("Guide")).not.toBeInTheDocument();
    expect(screen.getByText("Price")).toBeInTheDocument();
  });

  it("toggles a workflow off and routes an edit", () => {
    const onEdit = vi.fn();
    render(<WorkflowPool onCreate={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText("Guide active"));
    expect(setActive.mutate).toHaveBeenCalledWith({ id: "r1", is_active: false });
    fireEvent.click(screen.getByLabelText("Edit Guide"));
    expect(onEdit).toHaveBeenCalledWith("r1");
  });

  it("warns that deleting takes the history with it, and only deletes on confirm", () => {
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Delete Guide"));
    expect(screen.getByText(/its history is deleted with it/)).toBeInTheDocument();
    expect(remove.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove.mutate).toHaveBeenCalledWith("r1");
  });

  it("shows dashes, not zeros, when the counters could not be read", () => {
    // Zeros would say "none of your funnels has ever fired" — the alarming reading, and the
    // wrong one. The workflows themselves are unaffected, so the list still renders.
    hooks.statsError = true;
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText(/Activity counters could not be loaded/)).toBeInTheDocument();
    expect(screen.getByLabelText("Guide: comments claimed")).toHaveTextContent("—");
    expect(screen.getByText("Guide")).toBeInTheDocument();
    expect(screen.queryByText(/failed$/)).not.toBeInTheDocument();
  });

  it("says a load failed rather than showing an empty list", () => {
    // The two look identical on screen and only one of them is true.
    hooks.isError = true;
    render(<WorkflowPool onCreate={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText("Guide")).not.toBeInTheDocument();
  });
});
