import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { YouTubeCommentsScreen, Stage4RecoveredOperations } from "../ui/YouTubeCommentsScreen";
import type { YouTubeCommentsGateway } from "../application/ports";
import type {
  Stage4CapabilitiesPayload,
  Stage4CommentRow,
  Stage4ReceiptPayload,
} from "../domain/types";
import { YouTubeCommentsError } from "../domain/errors";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function capabilities(overrides: Partial<Record<"read" | "held" | "write" | "ban", boolean>> = {}): Stage4CapabilitiesPayload {
  const full = { read: true, held: true, write: true, ban: false, ...overrides };
  return {
    account_id: ACCOUNT,
    capabilities: {
      read: { allowed: full.read, reason: full.read ? null : "capability_off" },
      held: { allowed: full.held, reason: full.held ? null : "capability_off" },
      write: { allowed: full.write, reason: full.write ? null : "capability_off" },
      ban: { allowed: full.ban, reason: full.ban ? null : "capability_off" },
    },
  };
}

let handleSeq = 0;
function row(overrides: Partial<Stage4CommentRow> = {}): Stage4CommentRow {
  handleSeq += 1;
  return {
    handle: `hdl-fake-${handleSeq}`,
    kind: "thread",
    comment_id: `c-${handleSeq}`,
    thread_id: "t-1",
    video_id: "vid-1",
    canonical_parent_id: "",
    author_channel_id: "UC-author-1",
    author_name: "Author One",
    author_avatar_url: null,
    text: "a top-level comment",
    published_at: "2026-01-02T00:00:00Z",
    like_count: 2,
    moderation_status: "published",
    is_own: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<Stage4ReceiptPayload> = {}): Stage4ReceiptPayload {
  return {
    operation_id: "op-1",
    action: "create_thread",
    state: "confirmed",
    reason: null,
    provider_class: null,
    moderation_status: null,
    ban_requested: false,
    result_thread_id: "t-new",
    result_comment_id: "c-new",
    binding_generation: 1,
    channel_id: "UC-x",
    ...overrides,
  };
}

interface GatewayScript {
  caps?: Stage4CapabilitiesPayload;
  videos?: Array<{ id: string; title: string }>;
  threads?: Stage4CommentRow[];
  threadError?: string;
  replies?: Stage4CommentRow[];
  /** A thunk, so a scripted rejection is only created when the call happens. */
  createResult?: () => Promise<Stage4ReceiptPayload>;
  statusResult?: Promise<{ state: string; reason: string | null }>;
  moderateImpl?: (status: string, banConfirmation?: string) => Promise<Stage4ReceiptPayload>;
  deleteError?: string;
  /** Makes operationStatus fail (temporary) instead of answering. */
  statusError?: string;
}

function makeGateway(script: GatewayScript) {
  const calls = {
    create: 0,
    moderate: [] as Array<{ status: string; banConfirmation?: string }>,
    banConfirmations: 0,
    banKeys: [] as string[],
    moderateKeys: [] as string[],
    deleted: [] as string[],
    storageAtCreate: null as unknown[],
  };
  const gateway: YouTubeCommentsGateway = {
    capabilities: vi.fn(async () => script.caps ?? capabilities()),
    videoPage: vi.fn(async () => ({
      account_id: ACCOUNT,
      channel_id: "UC-x",
      items: (script.videos ?? [{ id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null }]).map((v) => ({
        id: v.id, title: v.title, published_at: null, thumbnail_url: null,
      })),
      next_cursor: null,
    })),
    threadPage: vi.fn(async () => {
      if (script.threadError) throw new YouTubeCommentsError(script.threadError);
      return {
        account_id: ACCOUNT,
        channel_id: "UC-x",
        video_id: "vid-1",
        list: "published" as const,
        items: script.threads ?? [row(), row({ kind: "reply", comment_id: "c-reply", canonical_parent_id: "c-1", handle: "hdl-reply" })],
        next_cursor: null,
        inconsistent_count: 0,
      };
    }),
    replyPage: vi.fn(async () => ({
      account_id: ACCOUNT,
      channel_id: "UC-x",
      parent_handle: "hdl-any",
      items: script.replies ?? [],
      next_cursor: null,
      inconsistent_count: 0,
    })),
    createThread: vi.fn(async () => {
      calls.create += 1;
      calls.storageAtCreate = JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]");
      return script.createResult ? script.createResult() : receipt();
    }),
    reply: vi.fn(async () => receipt({ action: "reply" })),
    edit: vi.fn(async () => receipt({ action: "edit" })),
    banConfirmation: vi.fn(async (params: { accountId: string; targetHandle: string; operationId: string }) => {
      calls.banConfirmations += 1;
      calls.banKeys.push(params.operationId);
      return {
        confirmation: "bnc-server-token",
        expires_in_seconds: 120,
        author_channel_id: "UC-author-1",
        author_name: "Author One",
      };
    }),
    deleteOwnComment: vi.fn(async (params: { accountId: string; commentId: string }) => {
      calls.deleted.push(params.commentId);
      if (script.deleteError) throw new YouTubeCommentsError(script.deleteError);
    }),
    moderate: vi.fn(async (_params: { status: "published" | "heldForReview" | "rejected"; banConfirmation?: string; operationId: string }) => {
      calls.moderateKeys.push(_params.operationId);
      if (script.moderateImpl) return script.moderateImpl(_params.status, _params.banConfirmation);
      calls.moderate.push({ status: _params.status, banConfirmation: _params.banConfirmation });
      return receipt({ action: "moderate", moderation_status: _params.status, ban_requested: !!_params.banConfirmation });
    }),
    operationStatus: vi.fn(async (): Promise<import("../domain/types").Stage4OperationStatusPayload> => {
      if (script.statusError) throw new YouTubeCommentsError(script.statusError);
      if (script.statusResult) {
        const over = await script.statusResult;
        return {
          operation_id: "op-x",
          action: "create_thread",
          state: over.state as "confirmed" | "refused" | "indeterminate",
          reason: (over.reason ?? null) as never,
          provider_class: null,
          moderation_status: null,
          ban_requested: false,
          result_thread_id: null,
          result_comment_id: null,
          binding_generation: 1,
          channel_id: "UC-x",
          observation: null,
          observed_text: null,
        };
      }
      return {
        operation_id: "op-x",
        action: "create_thread",
        state: "confirmed",
        reason: null,
        provider_class: null,
        moderation_status: null,
        ban_requested: false,
        result_thread_id: null,
        result_comment_id: null,
        binding_generation: 1,
        channel_id: "UC-x",
        observation: null,
        observed_text: null,
      };
    }),
  };
  return { gateway, calls };
}

function renderScreen(script: GatewayScript) {
  const { gateway, calls } = makeGateway(script);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
    </QueryClientProvider>,
  );
  return { gateway, calls };
}

beforeEach(() => {
  localStorage.clear();
  handleSeq = 0;
});

describe("YouTubeCommentsScreen", () => {
  it("renders the picker and the Published list with the Held tab on", async () => {
    renderScreen({ threads: [row()] });
    expect(await screen.findByText("First upload")).toBeInTheDocument();
    expect(await screen.findByText("a top-level comment")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Held for review" })).toBeInTheDocument();
  });

  it("hides the Held tab when the held capability is off", async () => {
    renderScreen({ caps: capabilities({ held: false }), threads: [row()] });
    await screen.findByText("a top-level comment");
    expect(screen.queryByRole("tab", { name: "Held for review" })).not.toBeInTheDocument();
  });

  it("hides every write control when the write capability is off", async () => {
    renderScreen({ caps: capabilities({ write: false }), threads: [row()] });
    await screen.findByText("a top-level comment");
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("yt-stage4-composer")).not.toBeInTheDocument();
  });

  it("shows the moderation controls from the visible row's own status only", async () => {
    renderScreen({
      threads: [
        row({ comment_id: "c-pub", handle: "hdl-pub", moderation_status: "published", text: "published row" }),
        row({ comment_id: "c-held", handle: "hdl-held", moderation_status: "heldForReview", text: "held row" }),
        row({ comment_id: "c-null", handle: "hdl-null", moderation_status: null, text: "unannotated row" }),
      ],
    });
    await screen.findByText("published row");
    // published -> Hold + Reject; heldForReview -> Publish + Reject; null -> none.
    expect(screen.getAllByRole("button", { name: "Hold" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Publish" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Reject" }).length).toBe(2);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("tells comments-disabled and reconnect-needed apart", async () => {
    renderScreen({ threadError: "comments_disabled" });
    await waitFor(() => expect(screen.getByText(/Comments are turned off for this video/)).toBeInTheDocument());
  });

  it("shows the reconnect copy for a scope refusal", async () => {
    renderScreen({ threadError: "scope_missing" });
    await waitFor(() => expect(screen.getByText(/Reconnect this channel to grant comment access/)).toBeInTheDocument());
  });

  it("shows the true empty state when the list is genuinely empty", async () => {
    renderScreen({ threads: [] });
    await waitFor(() => expect(screen.getByTestId("yt-stage4-empty")).toHaveTextContent("No comments yet"));
  });

  it("merges replies by comment id across inline previews and reply pages", async () => {
    const inline = row({ kind: "reply", comment_id: "c-dup", handle: "hdl-dup", canonical_parent_id: "c-1", text: "dup reply" });
    renderScreen({
      threads: [row({ text: "top text" }), inline],
      replies: [
        inline,
        row({ kind: "reply", comment_id: "c-fresh", handle: "hdl-fresh", canonical_parent_id: "c-1", text: "fresh reply" }),
      ],
    });
    await screen.findByText("top text");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await waitFor(() => expect(screen.getByTestId("yt-stage4-replies")).toBeInTheDocument());
    // The paged reply only appears once its page resolves; the inline preview
    // is already merged by comment id.
    await waitFor(() => expect(screen.getByText("fresh reply")).toBeInTheDocument());
    // The duplicated reply renders exactly once.
    expect(screen.getAllByText("dup reply")).toHaveLength(1);
    expect(screen.getByText("top text")).toBeInTheDocument();
  });

  it("writes the operation identity to storage BEFORE the request and clears it once confirmed", async () => {
    const { calls } = renderScreen({ threads: [row()] });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "First!" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(calls.create).toBe(1));
    expect(calls.storageAtCreate.length).toBe(1);
    expect(calls.storageAtCreate[0]).toMatchObject({ accountId: ACCOUNT, videoId: "vid-1", action: "create_thread" });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toEqual([]);
    });
  });

  it("keeps the draft and shows the refusal copy when the server refuses", async () => {
    renderScreen({
      threads: [row()],
      createResult: () => Promise.reject(new YouTubeCommentsError("possible_duplicate")),
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/);
    fireEvent.change(input, { target: { value: "again" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/same comment may already be on its way/));
    expect((input as HTMLTextAreaElement).value).toBe("again");
  });

  it("never re-sends an indeterminate operation: the same submit answers pending", async () => {
    const { calls, gateway } = renderScreen({
      threads: [row()],
      createResult: () => Promise.resolve(receipt({ state: "indeterminate", reason: "indeterminate" })),
    });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "ghost" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/may or may not have been applied/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByText(/still being checked/)).toBeInTheDocument());
    expect(calls.create).toBe(1);
    expect(gateway.createThread).toHaveBeenCalledTimes(1);
  });

  it("restores a pending operation on mount and reads its status before anything else", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-restored",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "create_thread",
      targetCommentId: "",
      createdAt: Date.now(),
    }]));
    const { gateway } = renderScreen({
      threads: [row()],
      statusResult: Promise.resolve({ state: "indeterminate", reason: null }),
    });
    await waitFor(() => expect(gateway.operationStatus).toHaveBeenCalledWith({ accountId: ACCOUNT, operationId: "op-restored" }));
    expect(await screen.findByTestId("yt-stage4-recovered")).toHaveTextContent(/may or may not have been applied/);
  });

  it("shows the post-reconnect copy when status answers not_found", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-rebind",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "reply",
      targetCommentId: "c-1",
      createdAt: Date.now(),
    }]));
    renderScreen({
      threads: [row()],
      statusResult: Promise.reject(new YouTubeCommentsError("not_found")),
    });
    const banner = await screen.findByTestId("yt-stage4-recovered");
    expect(banner).toHaveTextContent(/started before the channel was reconnected/);
    expect(banner).toHaveTextContent(/Check the video on YouTube/);
  });

  it("refuses an edit the server refuses even when the row claims is_own", async () => {
    const { gateway } = renderScreen({
      threads: [row({ is_own: true, comment_id: "c-own", handle: "hdl-own" })],
    });
    (gateway.edit as ReturnType<typeof vi.fn>).mockRejectedValue(new YouTubeCommentsError("target_not_owned"));
    await screen.findByText("a top-level comment");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Edit your comment/), { target: { value: "hijack" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Only comments your channel wrote/));
  });

  it("walks the two-step ban flow, discards on cancel, and confirms through the server token", async () => {
    const { calls } = renderScreen({
      caps: capabilities({ ban: true }),
      threads: [row({ comment_id: "c-ban", handle: "hdl-ban", text: "the ban target" })],
    });
    await screen.findByText("the ban target");

    // Open the reject dialog from the row.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    let dialog = await screen.findByRole("dialog");

    // First dialog: the consequences copy and the unchecked ban option.
    expect(within(dialog).getByText(/Reject this comment\?/)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be published again through Postora/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Also ban this author/)).toBeInTheDocument();

    // Cancel at the first step discards everything.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.banConfirmations).toBe(0);

    // Again, this time through the second dialog.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    });
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Also ban this author\?/)).toBeInTheDocument();

    // The second dialog names the author and states the limits; it never
    // asserts a ban and offers no undo.
    const body = within(dialog).getByText(/Postora will ask YouTube/);
    expect(body).toHaveTextContent(/Author One/);
    expect(body).toHaveTextContent(/cannot show whether an author is banned/);
    expect(body).toHaveTextContent(/cannot reverse it/);

    // Back discards the token and the selection, making it a plain reject.
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^Reject$/ }));
    });
    await waitFor(() => expect(calls.moderate.length).toBe(1));
    expect(calls.moderate[0]).toEqual({ status: "rejected", banConfirmation: undefined });

    // A full walk sends the server token with the reject.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    });
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Also ban this author\?/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Reject and ban" }));
    });
    await waitFor(() => expect(calls.moderate.length).toBe(2));
    expect(calls.moderate[1]).toEqual({ status: "rejected", banConfirmation: "bnc-server-token" });
    // The server bound the confirmation to the dialog's operation key, so the
    // submit MUST reuse it: a fresh key would be refused as a mismatch.
    expect(calls.banKeys).toHaveLength(2);
    expect(calls.moderateKeys[1]).toBe(calls.banKeys[1]);
    // And an accepted reject-and-ban is reported as accepted, not as unknown.
    expect(await screen.findByTestId("yt-stage4-notice")).toHaveTextContent(/Done/);
  });

  it("reports a confirmed create as posted, never as 'may or may not have been applied'", async () => {
    renderScreen({ threads: [row()] });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    expect(await screen.findByTestId("yt-stage4-notice")).toHaveTextContent(/Posted/);
    expect(screen.queryByText(/may or may not have been applied/)).not.toBeInTheDocument();
    // The composer was cleared because the outcome was shown.
    expect((screen.getByLabelText(/Post a comment as your channel/) as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps a pending identity and offers a status check when the status read fails temporarily", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-flaky",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "create_thread",
      targetCommentId: "",
      createdAt: Date.now(),
    }]));
    const script: GatewayScript = { threads: [row()], statusError: "rate_limited" };
    const { gateway } = renderScreen(script);
    const banner = await screen.findByTestId("yt-stage4-recovered");
    // A 429 is NOT a reconnect: the copy says the status could not be checked right now.
    expect(banner).toHaveTextContent(/could not be checked right now/);
    expect(banner).not.toHaveTextContent(/reconnected/);
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);

    // The failure clears; the owner checks again and sees the real outcome.
    script.statusError = undefined;
    script.statusResult = Promise.resolve({ state: "confirmed", reason: null });
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Check status" }));
    });
    await waitFor(() => expect(screen.getByTestId("yt-stage4-recovered")).toHaveTextContent(/accepted by YouTube/));
    expect(gateway.operationStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toEqual([]);
    });
  });

  it("deletes only the channel's own comment, through the existing delete path, after a confirmation", async () => {
    const { calls } = renderScreen({
      threads: [
        row({ comment_id: "c-mine", handle: "hdl-mine", text: "my own comment", is_own: true }),
        row({ comment_id: "c-theirs", handle: "hdl-theirs", text: "someone else", is_own: false }),
      ],
    });
    await screen.findByText("my own comment");
    // Exactly one Delete button: the foreign row has none.
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.deleted).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(calls.deleted).toEqual(["c-mine"]));
    expect(await screen.findByTestId("yt-stage4-notice")).toHaveTextContent(/Deleted/);
  });

  it("drops the notice when the selected video changes", async () => {
    renderScreen({
      videos: [{ id: "vid-1", title: "First upload" }, { id: "vid-2", title: "Second upload" }],
      threads: [row()],
    });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    expect(await screen.findByTestId("yt-stage4-notice")).toHaveTextContent(/Posted/);
    fireEvent.click(screen.getByRole("option", { name: "Second upload" }));
    await waitFor(() => expect(screen.queryByTestId("yt-stage4-notice")).not.toBeInTheDocument());
  });

  it("a late response for the previous account never reaches the new account's view", async () => {
    const ACCOUNT_B = "55555555-5555-4555-8555-555555555555";
    const { gateway } = makeGateway({});
    let releaseA!: () => void;
    const lateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const listFor = (accountId: string, text: string) => ({
      account_id: accountId, channel_id: "UC-x", video_id: "vid-1", list: "published" as const,
      items: [row({ text })], next_cursor: null, inconsistent_count: 0,
    });
    (gateway.capabilities as ReturnType<typeof vi.fn>).mockImplementation(async (accountId: string) => ({ ...capabilities(), account_id: accountId }));
    (gateway.videoPage as ReturnType<typeof vi.fn>).mockImplementation(async (accountId: string) => ({
      account_id: accountId, channel_id: "UC-x", items: [{ id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null }], next_cursor: null,
    }));
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async (params: { accountId: string }) => {
      if (params.accountId === ACCOUNT) {
        await lateA; // account A's answer arrives only AFTER the switch
        return listFor(ACCOUNT, "row of account A");
      }
      return listFor(ACCOUNT_B, "row of account B");
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (accountId: string) => (
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={accountId} gateway={gateway} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(ACCOUNT));
    await waitFor(() => expect(gateway.threadPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT })));

    rerender(tree(ACCOUNT_B));
    expect(await screen.findByText("row of account B")).toBeInTheDocument();

    releaseA();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByText("row of account A")).not.toBeInTheDocument();
    expect(screen.getByText("row of account B")).toBeInTheDocument();
  });

  it("a result that lands after the video changed is never shown as a notice on the new video", async () => {
    let resolveCreate!: (value: Stage4ReceiptPayload) => void;
    renderScreen({
      videos: [{ id: "vid-1", title: "First upload" }, { id: "vid-2", title: "Second upload" }],
      threads: [row()],
      createResult: () => new Promise<Stage4ReceiptPayload>((resolve) => { resolveCreate = resolve; }),
    });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "late one" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    fireEvent.click(screen.getByRole("option", { name: "Second upload" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Second upload" })).toHaveAttribute("aria-selected", "true"));

    await act(async () => { resolveCreate(receipt()); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByTestId("yt-stage4-notice")).not.toBeInTheDocument();
  });

  it("after a confirmed write the list returns to and refetches page ONE, not the last page", async () => {
    const { gateway } = makeGateway({});
    const requestedCursors: Array<string | null | undefined> = [];
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async (params: { cursor?: string | null }) => {
      requestedCursors.push(params.cursor);
      const first = !params.cursor;
      return {
        account_id: ACCOUNT, channel_id: "UC-x", video_id: "vid-1", list: "published" as const,
        items: [row({ text: first ? "page one row" : "page two row" })],
        next_cursor: first ? "cursor-2" : null, inconsistent_count: 0,
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("page one row")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    expect(await screen.findByText("page two row")).toBeInTheDocument();
    expect(requestedCursors.at(-1)).toBe("cursor-2");

    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "reload me" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(requestedCursors.length).toBeGreaterThanOrEqual(3));
    // The refetch is of page one (no cursor), never a repeat of page two.
    expect(requestedCursors.at(-1)).toBeUndefined();
    expect(await screen.findByText("page one row")).toBeInTheDocument();
  });

  it("a recovery view torn down before its status read finishes leaves the identity for the next view", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-torn", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread",
      targetCommentId: "", createdAt: Date.now(),
    }]));
    let release!: (value: { state: string; reason: string | null }) => void;
    const { gateway } = makeGateway({ statusResult: new Promise((resolve) => { release = resolve; }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <Stage4RecoveredOperations userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(gateway.operationStatus).toHaveBeenCalledTimes(1));
    unmount(); // an account or mode switch tears the view down mid-read
    await act(async () => { release({ state: "confirmed", reason: null }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);
  });

  it("keeps the not-admitted card but still recovers a pending receipt with reads off", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-dark",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "create_thread",
      targetCommentId: "",
      createdAt: Date.now(),
    }]));
    const { gateway } = renderScreen({
      caps: capabilities({ read: false, held: false, write: false, ban: false }),
      statusResult: Promise.resolve({ state: "indeterminate", reason: null }),
    });
    // The not-admitted card is shown (reads are off) ...
    expect(await screen.findByText("The new YouTube comments view is not enabled for this channel")).toBeInTheDocument();
    // ... and the pending receipt's status was still read and surfaced.
    await waitFor(() => expect(gateway.operationStatus).toHaveBeenCalledWith({ accountId: ACCOUNT, operationId: "op-dark" }));
    expect(await screen.findByTestId("yt-stage4-recovered")).toHaveTextContent(/may or may not have been applied/);
    // No list or provider read happened for the dark account.
    expect(gateway.threadPage).not.toHaveBeenCalled();
    expect(gateway.videoPage).not.toHaveBeenCalled();
  });

  it("the standalone recovery surface works on the legacy path with no list read at all", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-legacy",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "reply",
      targetCommentId: "c-1",
      createdAt: Date.now(),
    }]));
    const { gateway } = makeGateway({ statusResult: Promise.resolve({ state: "confirmed", reason: null }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Stage4RecoveredOperations userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("yt-stage4-recovered-standalone")).toHaveTextContent(/accepted by YouTube/);
    expect(gateway.operationStatus).toHaveBeenCalledTimes(1);
    expect(gateway.threadPage).not.toHaveBeenCalled();
    expect(gateway.videoPage).not.toHaveBeenCalled();
    expect(gateway.capabilities).not.toHaveBeenCalled();
    // A settled outcome clears its durable identity.
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toEqual([]);
    });
  });
});
