import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ReviewGatewayError, TikTokReviewGatewayProvider, type TikTokReviewGateway } from "../application/ports";
import type { CreatorInfo, MediaPreview, ReviewDraft, ReviewState, SubmissionResult, TikTokAccount } from "../domain/types";
import { ReviewDetail } from "./ReviewDetail";
import { TikTokReviewWorkspace } from "./TikTokReviewWorkspace";

vi.mock("@/components/post/MediaLibraryPicker", () => ({
  MediaLibraryPicker: () => null,
}));

function createDefaultCreator(): CreatorInfo {
  return {
    nickname: "Creator Test",
    username: "creator_test",
    avatarUrl: null,
    privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: true, // Duet disabled by creator as required
    stitchDisabled: false,
    maxVideoPostDurationSec: 60,
    postingBlocked: false,
    postingBlockedReason: null,
  };
}

function createDefaultDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "draft-1",
    accountId: "acc-1",
    revision: 1,
    state: "pending_review",
    caption: "Test draft caption",
    mediaFileId: "media-file-1",
    mediaDurationSec: 30,
    settings: {
      privacy: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      disclose: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    },
    rejectionReason: null,
    updatedAt: "2026-09-30T12:00:00Z",
    submission: null,
    ...overrides,
  };
}

function createDefaultAccounts(): TikTokAccount[] {
  return [
    { id: "acc-1", username: "creator_one", avatarUrl: null },
    { id: "acc-2", username: "creator_two", avatarUrl: null },
  ];
}

interface FixtureOptions {
  accounts?: TikTokAccount[];
  creator?: CreatorInfo;
  drafts?: ReviewDraft[];
  autoSelect?: boolean;
}

function renderReviewFixture(options: FixtureOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const accounts = options.accounts ?? createDefaultAccounts();
  const creator = options.creator ?? createDefaultCreator();
  const draftStore: ReviewDraft[] = options.drafts
    ? [...options.drafts]
    : [createDefaultDraft()];

  const gateway: TikTokReviewGateway = {
    listAccounts: vi.fn().mockImplementation(() => Promise.resolve(accounts)),
    creatorInfo: vi.fn().mockImplementation(() => Promise.resolve(creator)),
    list: vi.fn().mockImplementation((accountId: string, state?: ReviewState) => {
      return Promise.resolve(
        draftStore.filter((d) => d.accountId === accountId && (!state || d.state === state)),
      );
    }),
    get: vi.fn().mockImplementation((draftId: string) => {
      const found = draftStore.find((d) => d.id === draftId);
      if (!found) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Draft not found", 404));
      }
      return Promise.resolve(found);
    }),
    create: vi.fn().mockImplementation((accountId: string) => {
      const created = createDefaultDraft({
        id: `draft-${Date.now()}`,
        accountId,
        revision: 1,
        caption: "New Draft",
      });
      draftStore.push(created);
      return Promise.resolve(created);
    }),
    save: vi.fn().mockImplementation((draftId, expectedRevision, patch) => {
      const index = draftStore.findIndex((d) => d.id === draftId);
      if (index === -1) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Draft not found", 404));
      }
      const existing = draftStore[index]!;
      const updated: ReviewDraft = {
        ...existing,
        ...patch,
        revision: expectedRevision + 1,
      };
      draftStore[index] = updated;
      return Promise.resolve(updated);
    }),
    reject: vi.fn().mockImplementation((draftId, expectedRevision, reason) => {
      const index = draftStore.findIndex((d) => d.id === draftId);
      if (index === -1) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Draft not found", 404));
      }
      const existing = draftStore[index]!;
      const updated: ReviewDraft = {
        ...existing,
        state: "rejected",
        rejectionReason: reason,
        revision: expectedRevision + 1,
      };
      draftStore[index] = updated;
      return Promise.resolve(updated);
    }),
    archive: vi.fn().mockImplementation((draftId, expectedRevision) => {
      const index = draftStore.findIndex((d) => d.id === draftId);
      const existing = draftStore[index]!;
      const updated: ReviewDraft = {
        ...existing,
        state: "archived",
        revision: expectedRevision + 1,
      };
      draftStore[index] = updated;
      return Promise.resolve(updated);
    }),
    restore: vi.fn().mockImplementation((draftId, expectedRevision) => {
      const index = draftStore.findIndex((d) => d.id === draftId);
      const existing = draftStore[index]!;
      const updated: ReviewDraft = {
        ...existing,
        state: "pending_review",
        revision: expectedRevision + 1,
      };
      draftStore[index] = updated;
      return Promise.resolve(updated);
    }),
    reopen: vi.fn().mockImplementation((draftId, expectedRevision) => {
      const index = draftStore.findIndex((d) => d.id === draftId);
      if (index === -1) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Draft not found", 404));
      }
      const existing = draftStore[index]!;
      const updated: ReviewDraft = {
        ...existing,
        state: "pending_review",
        revision: expectedRevision + 1,
      };
      draftStore[index] = updated;
      return Promise.resolve(updated);
    }),
    submit: vi.fn().mockResolvedValue({
      submissionId: "sub-123",
      postId: "post-123",
      state: "queued",
    }),
    status: vi.fn().mockResolvedValue({
      state: "processing",
      updatedAt: "2026-09-30T12:00:00Z",
      reason: null,
      postUrl: null,
    }),
    resolveMediaPreview: vi.fn().mockResolvedValue({
      previewUrl: "https://example.com/video.mp4",
      fileType: "video",
      durationSec: 30,
    }),
  };

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TikTokReviewGatewayProvider gateway={gateway}>
          {children}
        </TikTokReviewGatewayProvider>
      </QueryClientProvider>
    );
  }

  const renderResult = render(<TikTokReviewWorkspace headerLink={<span>Back</span>} />, {
    wrapper: Wrapper,
  });

  return {
    ...renderResult,
    gateway,
    queryClient,
    getDraftStore: () => draftStore,
  };
}

function getButtonDisabledReason(button: HTMLElement): string | null {
  const describedBy = button.getAttribute("aria-describedby");
  if (!describedBy) return null;
  const el = document.getElementById(describedBy);
  return el ? el.textContent : null;
}

async function selectFirstDraft() {
  const row = await screen.findByRole("button", { name: /Test draft caption/i });
  fireEvent.click(row);
  await screen.findByRole("heading", { name: "Test draft caption" });
}

async function grantConsentThroughSettings() {
  const settingsBtn = screen.getByRole("button", { name: "TikTok settings" });
  fireEvent.click(settingsBtn);

  const consentCheckbox = await screen.findByRole("checkbox", {
    name: /I consent to send this content/i,
  });
  fireEvent.click(consentCheckbox);

  const saveBtn = screen.getByRole("button", { name: "Save" });
  fireEvent.click(saveBtn);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Approve & publish" })).toBeEnabled();
  });
}

describe("TikTokReviewWorkspace Screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when settings are unconfirmed, Approve is disabled with reason, clicking or pressing 'a' opens no dialog and does not submit; in Edit, changing caption then Cancel restores original caption without saving", async () => {
    const { gateway } = renderReviewFixture();
    await selectFirstDraft();

    const approveBtn = screen.getByRole("button", { name: "Approve & publish" });
    expect(approveBtn).toBeDisabled();
    expect(getButtonDisabledReason(approveBtn)).toBe(
      "Open TikTok settings and confirm this post for the selected account.",
    );

    // Clicking disabled Approve does not open dialog or submit
    fireEvent.click(approveBtn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gateway.submit).not.toHaveBeenCalled();

    // Pressing 'a' while disabled does not open dialog or submit
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gateway.submit).not.toHaveBeenCalled();

    // In Edit, change caption text then Cancel: original caption is restored and save was not called
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "Post text" });
    expect(textarea).toHaveValue("Test draft caption");

    fireEvent.change(textarea, { target: { value: "Changed caption text before cancel" } });
    expect(textarea).toHaveValue("Changed caption text before cancel");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(gateway.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Post text" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Test draft caption" })).toBeInTheDocument();
  });

  it("list read failure renders an error state with Retry, not an empty queue", async () => {
    const { gateway } = renderReviewFixture();
    (gateway.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ReviewGatewayError("INTERNAL", "Database connection lost", 500),
    );

    // Initial render displays error alert and Retry button
    const errorAlert = await screen.findByRole("alert");
    expect(errorAlert).toHaveTextContent("Database connection lost");

    expect(screen.queryByText("No posts in this view.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Connect a TikTok account to start a review."),
    ).not.toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeInTheDocument();

    // Clicking Retry fetches list again and restores queue
    (gateway.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([createDefaultDraft()]);
    fireEvent.click(retryBtn);

    expect(await screen.findByRole("button", { name: /Test draft caption/i })).toBeInTheDocument();
  });

  it("pressing 'a' on the workspace opens confirmation dialog without calling gateway.submit; pressing 'a' inside textarea does nothing", async () => {
    const { gateway } = renderReviewFixture();
    await selectFirstDraft();
    await grantConsentThroughSettings();

    // Case 1: Enter caption editor, focus textarea, press 'a'
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "Post text" });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "a", code: "KeyA" });

    // Dialog must NOT open while focus is inside the textarea
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gateway.submit).not.toHaveBeenCalled();

    // Cancel edit mode
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Case 2: Press 'a' outside any input/textarea on the workspace
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" });

    // Confirmation dialog opens
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Publish this video now?")).toBeInTheDocument();

    // gateway.submit must NOT have been called merely by pressing 'a'
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it("Reject opens a dialog; the dialog Reject button is disabled until a reason is provided; a non-blank reason calls gateway.reject with expectedRevision and removes the post from the pending queue", async () => {
    const { gateway } = renderReviewFixture();
    await selectFirstDraft();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Reject this post")).toBeInTheDocument();

    // The Reject button inside the dialog is found by role/name (not CSS classes) and is initially disabled
    const dialogRejectBtn = within(dialog).getByRole("button", { name: "Reject" });
    expect(dialogRejectBtn).toBeDisabled();

    // Enter a non-blank reason
    const reasonInput = within(dialog).getByRole("textbox", { name: "Reason" });
    fireEvent.change(reasonInput, { target: { value: "Video needs copyright audio check" } });
    expect(dialogRejectBtn).toBeEnabled();

    // Click Reject with reason
    fireEvent.click(dialogRejectBtn);
    await waitFor(() => {
      expect(gateway.reject).toHaveBeenCalledTimes(1);
    });
    expect(gateway.reject).toHaveBeenCalledWith(
      "draft-1",
      1,
      "Video needs copyright audio check",
    );

    // Dialog closes
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Post leaves the pending queue (gateway.list for pending_review re-fetched without it)
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Test draft caption/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText("No posts in this view.")).toBeInTheDocument();
    expect(gateway.list).toHaveBeenLastCalledWith("acc-1", "pending_review");
  });

  it("after settings are saved with consent, editing and saving caption invalidates consent and disables Approve again", async () => {
    const { gateway } = renderReviewFixture();
    await selectFirstDraft();
    await grantConsentThroughSettings();

    expect(screen.getByRole("button", { name: "Approve & publish" })).toBeEnabled();

    // Start editing caption
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "Post text" });
    fireEvent.change(textarea, { target: { value: "Updated caption text" } });

    // Save caption (creates new revision 2 via gateway.save)
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(gateway.save).toHaveBeenCalled();
    });

    // Approve button must be disabled again because consent was invalidated by revision/caption change
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Approve & publish" })).toBeDisabled();
    });

    const approveBtn = screen.getByRole("button", { name: "Approve & publish" });
    expect(getButtonDisabledReason(approveBtn)).toBe(
      "Open TikTok settings and confirm this post for the selected account.",
    );
  });

  it("in the confirmation dialog, first submit rejects, second click succeeds carrying the SAME requestId; then status view renders and no Publish ID field exists", async () => {
    const { gateway } = renderReviewFixture();
    await selectFirstDraft();
    await grantConsentThroughSettings();

    // Open confirmation dialog
    fireEvent.click(screen.getByRole("button", { name: "Approve & publish" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: "Confirm" });

    // First submit fails
    (gateway.submit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ReviewGatewayError("NETWORK", "Network timeout occurred", 500),
    );
    fireEvent.click(confirmBtn);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Network timeout occurred");
    expect(gateway.submit).toHaveBeenCalledTimes(1);

    const firstCommand = (gateway.submit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(firstCommand.requestId).toBeTruthy();

    // Second submit succeeds (retry with same dialog)
    (gateway.submit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      submissionId: "sub-999",
      postId: "post-999",
      state: "queued",
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(gateway.submit).toHaveBeenCalledTimes(2);
    });

    const secondCommand = (gateway.submit as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    // Idempotent retry: must carry the EXACT SAME requestId
    expect(secondCommand.requestId).toBe(firstCommand.requestId);

    // Dialog closes and outcome view appears
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Outcome")).toBeInTheDocument();

    // No Publish ID field exists
    expect(screen.queryByLabelText(/publish id/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/publish id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/publish id/i)).not.toBeInTheDocument();
  });

  it("in the confirmation dialog, a concurrent second click while a submit is in flight is ignored", async () => {
    let resolveSubmit!: (res: SubmissionResult) => void;
    const submitPromise = new Promise<SubmissionResult>((resolve) => {
      resolveSubmit = resolve;
    });

    const { gateway } = renderReviewFixture();
    (gateway.submit as ReturnType<typeof vi.fn>).mockImplementation(() => submitPromise);

    await selectFirstDraft();
    await grantConsentThroughSettings();

    fireEvent.click(screen.getByRole("button", { name: "Approve & publish" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const confirmBtn = within(dialog).getByRole("button", { name: "Confirm" });

    // Fire both clicks inside ONE act() before re-render so the in-flight guard (not the disabled button) is what blocks
    act(() => {
      fireEvent.click(confirmBtn);
      fireEvent.click(confirmBtn);
    });

    // Resolve the in-flight submit promise
    await act(async () => {
      resolveSubmit({
        submissionId: "sub-123",
        postId: "post-123",
        state: "queued",
      });
    });

    // Wait for the dialog to close
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Assert submit called exactly once
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it("Schedule action disabled reason is 'Pick a time to enable schedule.' when no time is picked, even if settings are unconfirmed", async () => {
    renderReviewFixture();
    await selectFirstDraft();

    // Settings are unconfirmed: Approve reason is about settings
    const approveBtn = screen.getByRole("button", { name: "Approve & publish" });
    expect(approveBtn).toBeDisabled();
    expect(getButtonDisabledReason(approveBtn)).toBe(
      "Open TikTok settings and confirm this post for the selected account.",
    );

    // Schedule action is disabled with schedule reason
    const scheduleBtn = screen.getByRole("button", { name: "Schedule" });
    expect(scheduleBtn).toBeDisabled();
    expect(getButtonDisabledReason(scheduleBtn)).toBe("Pick a time to enable schedule.");
  });

  it("while the caption editor is dirty the Approve reason is 'Save or cancel your caption edit first.'", async () => {
    renderReviewFixture();
    await selectFirstDraft();
    await grantConsentThroughSettings();

    expect(screen.getByRole("button", { name: "Approve & publish" })).toBeEnabled();

    // Start editing caption and make it dirty
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "Post text" });
    fireEvent.change(textarea, { target: { value: "Dirty modified caption" } });

    // Approve button should be disabled with the dirty reason
    const approveBtn = screen.getByRole("button", { name: "Approve & publish" });
    expect(approveBtn).toBeDisabled();
    expect(getButtonDisabledReason(approveBtn)).toBe("Save or cancel your caption edit first.");

    // Canceling edit reverts the reason and restores enabled Approve button
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Approve & publish" })).toBeEnabled();
  });

  it("preview shows loading state and error-with-retry state distinctly, and 'No video attached.' only when mediaFileId is null", async () => {
    // 1. mediaFileId is null -> 'No video attached.'
    const draftNoMedia = createDefaultDraft({
      id: "draft-nomedia",
      mediaFileId: null,
      caption: "Draft without media",
    });
    const draftWithMedia = createDefaultDraft({
      id: "draft-media",
      mediaFileId: "media-file-2",
      caption: "Draft with media",
    });

    let resolvePreview!: (val: MediaPreview) => void;
    let rejectPreview!: (err: unknown) => void;
    const previewPromise = new Promise<MediaPreview>((resolve, reject) => {
      resolvePreview = resolve;
      rejectPreview = reject;
    });

    const { gateway } = renderReviewFixture({
      drafts: [draftNoMedia, draftWithMedia],
    });

    // Mock resolveMediaPreview for draft-media to remain pending initially
    (gateway.resolveMediaPreview as ReturnType<typeof vi.fn>).mockImplementation(() => previewPromise);

    const rowNoMedia = await screen.findByRole("button", { name: /Draft without media/i });
    fireEvent.click(rowNoMedia);
    await screen.findByRole("heading", { name: "Draft without media" });

    expect(screen.getByText("No video attached.")).toBeInTheDocument();
    expect(screen.queryByText("Loading video preview…")).not.toBeInTheDocument();
    expect(screen.queryByText("That video could not be loaded.")).not.toBeInTheDocument();

    // 2. Draft with mediaFileId, but resolveMediaPreview is pending -> loading state
    const rowMedia = await screen.findByRole("button", { name: /Draft with media/i });
    fireEvent.click(rowMedia);
    await screen.findByRole("heading", { name: "Draft with media" });

    expect(screen.getByText("Loading video preview…")).toBeInTheDocument();
    expect(screen.queryByText("No video attached.")).not.toBeInTheDocument();

    // 3. Reject the preview -> error state with Retry button
    rejectPreview(new ReviewGatewayError("INTERNAL", "Preview failed to load", 500));
    const errorAlert = await screen.findByText("Preview failed to load");
    expect(errorAlert).toBeInTheDocument();
    expect(screen.queryByText("No video attached.")).not.toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeInTheDocument();

    // Clicking Retry attempts refetch and renders real preview
    (gateway.resolveMediaPreview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      previewUrl: "https://example.com/video-ok.mp4",
      fileType: "video",
      durationSec: 30,
    });
    fireEvent.click(retryBtn);

    // Assert on what the real preview renders (title, video element, caption)
    expect(await screen.findByText("For You Preview")).toBeInTheDocument();
    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "https://example.com/video-ok.mp4");
    expect(screen.getByText("Draft with media", { selector: "p" })).toBeInTheDocument();
  });

  it("waiting count shows '100+ items waiting.' when the list returns 100 rows", async () => {
    const drafts100 = Array.from({ length: 100 }, (_, i) =>
      createDefaultDraft({ id: `draft-${i}`, accountId: "acc-1", caption: `Draft ${i}` }),
    );
    renderReviewFixture({ drafts: drafts100 });

    expect(await screen.findByText("100+ items waiting.")).toBeInTheDocument();
  });

  it("switching account clears the selected draft and never restores previous account's consent on return", async () => {
    const draftOne = createDefaultDraft({ id: "draft-acc1", accountId: "acc-1", caption: "Draft One" });
    const draftTwo = createDefaultDraft({ id: "draft-acc2", accountId: "acc-2", caption: "Draft Two" });

    renderReviewFixture({ drafts: [draftOne, draftTwo] });

    // Select draft one under acc-1 and grant consent
    const rowOne = await screen.findByRole("button", { name: /Draft One/i });
    fireEvent.click(rowOne);
    await screen.findByRole("heading", { name: "Draft One" });
    await grantConsentThroughSettings();
    expect(screen.getByRole("button", { name: "Approve & publish" })).toBeEnabled();

    // Switch account to acc-2
    const accountSelect = screen.getByRole("combobox", { name: "Account" });
    fireEvent.change(accountSelect, { target: { value: "acc-2" } });

    // Detail pane is cleared
    expect(await screen.findByText("Select a post to review it.")).toBeInTheDocument();

    // Switch back to acc-1
    fireEvent.change(accountSelect, { target: { value: "acc-1" } });

    // Reselect Draft One
    const rowOneAgain = await screen.findByRole("button", { name: /Draft One/i });
    fireEvent.click(rowOneAgain);
    await screen.findByRole("heading", { name: "Draft One" });

    // Consent did not survive the account switch even for the same draft: Approve is disabled
    const approveBtn = screen.getByRole("button", { name: "Approve & publish" });
    expect(approveBtn).toBeDisabled();
    expect(getButtonDisabledReason(approveBtn)).toBe(
      "Open TikTok settings and confirm this post for the selected account.",
    );
  });

  describe("Edit and resubmit (reopen) behavior for submitted drafts", () => {
    it.each(["failed", "needs_attention"] as const)(
      "a submitted draft whose status is '%s' shows 'Edit and resubmit'; clicking it calls gateway.reopen once, returning draft to pending_review with disabled Approve button",
      async (publishState) => {
        const submittedDraft = createDefaultDraft({
          id: "draft-submitted-1",
          accountId: "acc-1",
          revision: 3,
          state: "submitted",
          caption: "Submitted test draft",
          submission: {
            id: "sub-submitted-1",
            postId: "post-submitted-1",
            mode: "now",
            scheduledAt: null,
          },
        });

        const { gateway } = renderReviewFixture({
          drafts: [submittedDraft],
        });

        (gateway.status as ReturnType<typeof vi.fn>).mockResolvedValue({
          state: publishState,
          updatedAt: "2026-10-01T12:00:00Z",
          reason: publishState === "failed" ? "Upload failed" : "Needs attention reason",
          postUrl: null,
        });

        // Switch status filter to 'submitted' in queue
        const statusSelect = screen.getByRole("combobox", { name: "Status" });
        fireEvent.change(statusSelect, { target: { value: "submitted" } });

        // Select the submitted draft
        const draftBtn = await screen.findByRole("button", { name: /Submitted test draft/i });
        fireEvent.click(draftBtn);

        // Verify the 'Edit and resubmit' button is shown
        const reopenBtn = await screen.findByRole("button", { name: "Edit and resubmit" });
        expect(reopenBtn).toBeInTheDocument();

        // Click 'Edit and resubmit'
        fireEvent.click(reopenBtn);

        // Assert gateway.reopen was called once with (draftId, currentRevision)
        await waitFor(() => {
          expect(gateway.reopen).toHaveBeenCalledTimes(1);
        });
        expect(gateway.reopen).toHaveBeenCalledWith("draft-submitted-1", 3);

        // On success, draft returns to pending_review and Approve & publish is disabled again
        const approveBtn = await screen.findByRole("button", { name: "Approve & publish" });
        expect(approveBtn).toBeInTheDocument();
        expect(approveBtn).toBeDisabled();
        expect(getButtonDisabledReason(approveBtn)).toBe(
          "Open TikTok settings and confirm this post for the selected account.",
        );
      },
    );

    it("on a 409 INVALID_STATE error when clicking 'Edit and resubmit', the server message is shown and no state changes", async () => {
      const submittedDraft = createDefaultDraft({
        id: "draft-submitted-err",
        accountId: "acc-1",
        revision: 2,
        state: "submitted",
        caption: "Submitted draft err",
        submission: {
          id: "sub-submitted-err",
          postId: "post-submitted-err",
          mode: "now",
          scheduledAt: null,
        },
      });

      const { gateway } = renderReviewFixture({
        drafts: [submittedDraft],
      });

      (gateway.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: "failed",
        updatedAt: "2026-10-01T12:00:00Z",
        reason: "Upload failed",
        postUrl: null,
      });

      (gateway.reopen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ReviewGatewayError(
          "INVALID_STATE",
          "TikTok may still have this post. Check TikTok before trying again.",
          409,
        ),
      );

      const statusSelect = screen.getByRole("combobox", { name: "Status" });
      fireEvent.change(statusSelect, { target: { value: "submitted" } });

      const draftBtn = await screen.findByRole("button", { name: /Submitted draft err/i });
      fireEvent.click(draftBtn);

      const reopenBtn = await screen.findByRole("button", { name: "Edit and resubmit" });
      fireEvent.click(reopenBtn);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("TikTok may still have this post. Check TikTok before trying again.");

      // State did not change: still showing Edit and resubmit, draft is still submitted, filter still submitted
      expect(screen.getByRole("button", { name: "Edit and resubmit" })).toBeInTheDocument();
      expect(screen.getByText("Submitted", { selector: "p.tiktok-review-chip" })).toBeInTheDocument();
      expect(statusSelect).toHaveValue("submitted");
    });

    it.each(["processing", "published", "queued", "scheduled"] as const)(
      "'Edit and resubmit' button is absent for status '%s'",
      async (publishState) => {
        const submittedDraft = createDefaultDraft({
          id: `draft-sub-${publishState}`,
          accountId: "acc-1",
          revision: 2,
          state: "submitted",
          caption: `Submitted draft ${publishState}`,
          submission: {
            id: `sub-${publishState}`,
            postId: `post-${publishState}`,
            mode: "now",
            scheduledAt: null,
          },
        });

        const { gateway } = renderReviewFixture({
          drafts: [submittedDraft],
        });

        (gateway.status as ReturnType<typeof vi.fn>).mockResolvedValue({
          state: publishState,
          updatedAt: "2026-10-01T12:00:00Z",
          reason: null,
          postUrl: publishState === "published" ? "https://tiktok.com/@creator/video/1" : null,
        });

        const statusSelect = screen.getByRole("combobox", { name: "Status" });
        fireEvent.change(statusSelect, { target: { value: "submitted" } });

        const draftBtn = await screen.findByRole("button", { name: new RegExp(`Submitted draft ${publishState}`, "i") });
        fireEvent.click(draftBtn);

        await screen.findByText("Outcome");
        expect(screen.queryByRole("button", { name: "Edit and resubmit" })).not.toBeInTheDocument();
      },
    );

    it("pressing KeyA or KeyR does not trigger reopen on a submitted draft", async () => {
      const submittedDraft = createDefaultDraft({
        id: "draft-submitted-keys",
        accountId: "acc-1",
        revision: 2,
        state: "submitted",
        caption: "Submitted draft keys",
        submission: {
          id: "sub-keys",
          postId: "post-keys",
          mode: "now",
          scheduledAt: null,
        },
      });

      const { gateway } = renderReviewFixture({
        drafts: [submittedDraft],
      });

      (gateway.status as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: "failed",
        updatedAt: "2026-10-01T12:00:00Z",
        reason: "Failed publish",
        postUrl: null,
      });

      const statusSelect = screen.getByRole("combobox", { name: "Status" });
      fireEvent.change(statusSelect, { target: { value: "submitted" } });

      const draftBtn = await screen.findByRole("button", { name: /Submitted draft keys/i });
      fireEvent.click(draftBtn);

      await screen.findByRole("button", { name: "Edit and resubmit" });

      // Press KeyA and KeyR
      fireEvent.keyDown(window, { code: "KeyA" });
      fireEvent.keyDown(window, { code: "KeyR" });

      expect(gateway.reopen).not.toHaveBeenCalled();
    });
  });

  describe("mojibake check for user-visible strings", () => {
    it("renders loading, conflict, and status texts without any mojibake ('â€')", () => {
      const defaultDetailProps = {
        onReloadConflict: vi.fn(),
        narrow: false,
        onBack: vi.fn(),
        account: null,
        creator: null,
        preview: { kind: "ready" as const, media: { previewUrl: "https://example.com/v.mp4", fileType: "video" as const, durationSec: 30 } },
        onRetryPreview: vi.fn(),
        editing: false,
        captionDraft: "",
        onCaptionDraft: vi.fn(),
        onStartEdit: vi.fn(),
        onCancelEdit: vi.fn(),
        onSaveCaption: vi.fn(),
        saving: false,
        mediaNotice: null,
        onPickMedia: vi.fn(),
        onRemoveMedia: vi.fn(),
        scheduleLabel: "Schedule",
        controls: {
          timeZone: "UTC",
          scheduleLocal: "",
          scheduleNote: null,
          onScheduleLocal: vi.fn(),
          onNow: vi.fn(),
          onShortcut: vi.fn(),
          approveReason: null,
          scheduleReason: null,
          canReject: false,
          canEdit: false,
          canArchive: false,
          canRestore: false,
          settings: null,
          settingsOpen: false,
          onSettingsOpenChange: vi.fn(),
          onArchive: vi.fn(),
          onRestore: vi.fn(),
          onReject: vi.fn(),
          rejectPending: false,
          confirm: null,
          onOpenConfirm: vi.fn(),
          onCloseConfirm: vi.fn(),
          onConfirm: vi.fn(),
          confirmPending: false,
          confirmError: null,
          rejectOpen: false,
          onRejectOpenChange: vi.fn(),
        },
        publish: null,
      };

      // 1. Loading text
      const { container: loadingContainer } = render(
        <ReviewDetail {...defaultDetailProps} screen={{ kind: "loading" }} />,
      );
      expect(loadingContainer.textContent).toContain("Loading post…");
      expect(loadingContainer.textContent).not.toContain("â€");

      // 2. Conflict text
      const { container: conflictContainer } = render(
        <ReviewDetail {...defaultDetailProps} screen={{ kind: "conflict" }} />,
      );
      expect(conflictContainer.textContent).toContain("This post changed elsewhere — reload");
      expect(conflictContainer.textContent).not.toContain("â€");

      // 3. Status waiting text
      const { container: statusContainer } = render(
        <ReviewDetail
          {...defaultDetailProps}
          screen={{ kind: "ready", draft: createDefaultDraft({ state: "submitted" }) }}
          publish={{
            status: null,
            error: null,
            timedOut: false,
            refresh: vi.fn(),
            immediate: null,
            scheduledFor: null,
            reopen: null,
            reopening: false,
          }}
        />,
      );
      expect(statusContainer.textContent).toContain("Checking publish status…");
      expect(statusContainer.textContent).not.toContain("â€");

      // 4. Ready summary text (middle dot)
      const { container: readyContainer } = render(
        <ReviewDetail
          {...defaultDetailProps}
          screen={{ kind: "ready", draft: createDefaultDraft() }}
        />,
      );
      expect(readyContainer.textContent).toContain("·");
      expect(readyContainer.textContent).not.toContain("Â·");
      expect(readyContainer.textContent).not.toContain("â€");
    });
  });
});
