import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TikTokReviewGatewayProvider, type TikTokReviewGateway } from "../../application/ports";
import type { CreatorInfo, PublishStatus, ReviewDraft, ReviewState, TikTokAccount } from "../../domain/types";
import { ApprovalsView } from "./ApprovalsView";

vi.mock("@/components/post/MediaLibraryPicker", () => ({ MediaLibraryPicker: () => null }));

const creator: CreatorInfo = {
  nickname: "Creator One",
  username: "creator_one",
  avatarUrl: null,
  privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 60,
  postingBlocked: false,
  postingBlockedReason: null,
};

function makeDraft(overrides: Partial<ReviewDraft>): ReviewDraft {
  return {
    id: "d1",
    accountId: "acc-1",
    revision: 1,
    state: "pending_review",
    caption: "First post\nmore text",
    mediaFileId: null,
    mediaDurationSec: null,
    settings: {
      privacy: null,
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      disclose: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    },
    rejectionReason: null,
    updatedAt: "2026-10-14T10:00:00.000Z",
    submission: null,
    ...overrides,
  };
}

function setup(options: { drafts: ReviewDraft[]; accounts?: TikTokAccount[]; statuses?: Record<string, PublishStatus>; path?: string }) {
  const accounts = options.accounts ?? [
    { id: "acc-1", username: "creator_one", avatarUrl: null },
    { id: "acc-2", username: "creator_two", avatarUrl: null },
  ];
  const store = [...options.drafts];
  const update = (draftId: string, patch: Partial<ReviewDraft>) => {
    const index = store.findIndex((item) => item.id === draftId);
    const next = { ...store[index]!, ...patch, revision: store[index]!.revision + 1 };
    store[index] = next;
    return Promise.resolve(next);
  };
  const gateway: TikTokReviewGateway = {
    listAccounts: vi.fn(() => Promise.resolve(accounts)),
    creatorInfo: vi.fn(() => Promise.resolve(creator)),
    list: vi.fn((accountId: string, state: ReviewState) =>
      Promise.resolve(store.filter((item) => item.accountId === accountId && item.state === state))),
    get: vi.fn((draftId: string) => Promise.resolve(store.find((item) => item.id === draftId)!)),
    create: vi.fn((accountId: string) => {
      const created = makeDraft({ id: "new", accountId, caption: "" });
      store.push(created);
      return Promise.resolve(created);
    }),
    save: vi.fn((draftId, _revision, patch) => update(draftId, { ...patch, state: "pending_review" })),
    reject: vi.fn((draftId, _revision, reason) => update(draftId, { state: "rejected", rejectionReason: reason })),
    archive: vi.fn((draftId) => update(draftId, { state: "archived" })),
    restore: vi.fn((draftId) => update(draftId, { state: "pending_review" })),
    reopen: vi.fn((draftId) => update(draftId, { state: "pending_review", submission: null })),
    submit: vi.fn(() => Promise.resolve({ submissionId: "s1", postId: "p1", state: "queued" as const })),
    status: vi.fn((submissionId: string) => Promise.resolve(options.statuses?.[submissionId] ?? {
      state: "queued" as const, updatedAt: "2026-10-14T10:00:00.000Z", reason: null, postUrl: null, reopenable: false,
    })),
    resolveMediaPreview: vi.fn(() => Promise.resolve(null)),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TikTokReviewGatewayProvider gateway={gateway}>
        <MemoryRouter initialEntries={[options.path ?? "/approvals"]}>
          <ApprovalsView />
        </MemoryRouter>
      </TikTokReviewGatewayProvider>
    </QueryClientProvider>,
  );
  return gateway;
}

describe("ApprovalsView", () => {
  it("lists pending posts from every account and opens the first one", async () => {
    setup({
      drafts: [
        makeDraft({ id: "d1", caption: "First post", updatedAt: "2026-10-14T11:00:00.000Z" }),
        makeDraft({ id: "d2", accountId: "acc-2", caption: "Second post", updatedAt: "2026-10-14T09:00:00.000Z" }),
        makeDraft({ id: "d3", caption: "Old rejected", state: "rejected" }),
      ],
    });

    const list = await screen.findByRole("listbox", { name: "Posts" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    expect(within(list).getAllByRole("option").map((row) => row.textContent)).toEqual([
      expect.stringContaining("First post"),
      expect.stringContaining("Second post"),
    ]);
    expect(screen.getByText("2 items waiting.")).toBeInTheDocument();
    expect(await screen.findByRole("article", { name: "Approval detail: First post" })).toBeInTheDocument();
  });

  it("keeps Approve and Schedule disabled and flags the settings until the post is ready", async () => {
    setup({ drafts: [makeDraft({ id: "d1", caption: "Needs work" })] });
    const approve = await screen.findByRole("button", { name: /^Approve$/ });
    expect(approve).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Schedule$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "TikTok settings" }).querySelector(".ap-dot")).not.toBeNull();
    expect(screen.getByText(/Music Usage Confirmation/)).toBeInTheDocument();
  });

  it("rejects only with a reason", async () => {
    const gateway = setup({ drafts: [makeDraft({ id: "d1", caption: "Reject me", revision: 3 })] });
    fireEvent.click(await screen.findByRole("button", { name: "Reject & tell why" }));
    const confirm = screen.getByRole("button", { name: "Confirm reject" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "  wrong tone  " } });
    fireEvent.click(confirm);
    await waitFor(() => expect(gateway.reject).toHaveBeenCalledWith("d1", 3, "wrong tone"));
  });

  it("archives the ticked posts from the bulk bar", async () => {
    const gateway = setup({
      drafts: [makeDraft({ id: "d1", caption: "One" }), makeDraft({ id: "d2", caption: "Two", revision: 2 })],
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Two" }));
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Approve/ })).toBeDisabled();
    fireEvent.click(within(bar).getByRole("button", { name: /Archive/ }));
    await waitFor(() => expect(gateway.archive).toHaveBeenCalledWith("d2", 2));
    expect(gateway.archive).toHaveBeenCalledTimes(1);
  });

  it("shows a failed post in Approved and sends it back to pending", async () => {
    const failed = makeDraft({
      id: "d9",
      caption: "Failed upload",
      state: "submitted",
      revision: 4,
      submission: { id: "s9", postId: "p9", mode: "now", scheduledAt: null },
    });
    const gateway = setup({
      drafts: [failed],
      path: "/approvals?tab=approved",
      statuses: { s9: { state: "failed", updatedAt: "2026-10-14T10:00:00.000Z", reason: "tiktok_init_http_403", postUrl: null, reopenable: true } },
    });

    const row = await screen.findByRole("option", { name: /Failed upload/ });
    await waitFor(() => expect(within(row).getByText("Publish failed")).toBeInTheDocument());
    const back = await screen.findByRole("button", { name: /Back to pending/ });
    expect(screen.getByText("tiktok_init_http_403")).toBeInTheDocument();
    fireEvent.click(back);
    await waitFor(() => expect(gateway.reopen).toHaveBeenCalledWith("d9", 4));
  });

  it("does not offer Back to pending when TikTok has not confirmed the failure", async () => {
    const failed = makeDraft({
      id: "d8",
      caption: "Maybe live",
      state: "submitted",
      submission: { id: "s8", postId: "p8", mode: "now", scheduledAt: null },
    });
    const gateway = setup({
      drafts: [failed],
      path: "/approvals?tab=approved",
      statuses: { s8: { state: "needs_attention", updatedAt: "2026-10-14T10:00:00.000Z", reason: null, postUrl: null, reopenable: false } },
    });

    expect(await screen.findByText(/TikTok hasn't confirmed this attempt failed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Back to pending/ })).not.toBeInTheDocument();
    expect(gateway.reopen).not.toHaveBeenCalled();
  });

  it("creates a post for the chosen account", async () => {
    const gateway = setup({ drafts: [], accounts: [{ id: "acc-1", username: "creator_one", avatarUrl: null }] });
    expect(await screen.findByText("Nothing in this filter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New post/ }));
    await waitFor(() => expect(gateway.create).toHaveBeenCalledWith("acc-1"));
  });
});
