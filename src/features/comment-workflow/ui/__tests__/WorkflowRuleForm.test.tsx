import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useCommentWorkflowRules", () => ({
  useCommentWorkflowRules: () => ({
    rules: [],
    create: { isPending: false },
    update: { isPending: false },
  }),
}));

vi.mock("../../infrastructure/commentWorkflowApi", () => ({
  fetchRecentPosts: vi.fn().mockResolvedValue([]),
  fetchAttachableMedia: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    isError: false,
    data: [
      { id: "fb-1", platform: "facebook", platform_username: "Shop Page", avatar_url: null, is_active: true, needs_reauth: false },
      { id: "fb-2", platform: "facebook", platform_username: "Old Page", avatar_url: null, is_active: true, needs_reauth: true },
      { id: "ig-1", platform: "instagram", platform_username: "shop_ig", avatar_url: null, is_active: true, needs_reauth: false },
      { id: "th-1", platform: "threads", platform_username: "shop_th", avatar_url: null, is_active: true, needs_reauth: true },
    ],
  }),
}));

import { WorkflowRuleForm } from "../WorkflowRuleForm";

describe("WorkflowRuleForm platform picker", () => {
  it("counts the working accounts per platform and refuses a platform with none", () => {
    // The reported bug: one dropdown held every account, so a Threads page whose token had died
    // was offered for a Facebook funnel. The platform is chosen first now, and Threads -- whose
    // only account needs reconnecting -- offers nothing to choose.
    render(<WorkflowRuleForm ruleId={null} onDone={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Facebook/ })).toHaveTextContent("1 page connected");
    expect(screen.getByRole("button", { name: /Instagram/ })).toHaveTextContent(
      "1 account connected",
    );
    expect(screen.getByRole("button", { name: /Threads/ })).toBeDisabled();
    // No platform, no account picker -- there is nothing yet to choose between.
    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
  });

  // Also the regression test for the hydration effect: it was keyed on the `rules` array, which
  // react-query recreates on every render while the query is in flight, so the form reset itself
  // under the user and this click never stuck.
  it("names the chosen platform on the picker and says what it left out", () => {
    render(<WorkflowRuleForm ruleId={null} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Facebook/ }));

    expect(screen.getByText("Facebook page")).toBeInTheDocument();
    expect(screen.getByLabelText("Account")).toHaveTextContent("Choose a Facebook page");
    // Silently dropping the stale page reads as data loss, and Profiles is where it is fixed.
    expect(screen.getByText(/1 more page needs reconnecting on Profiles/)).toBeInTheDocument();
  });
});
