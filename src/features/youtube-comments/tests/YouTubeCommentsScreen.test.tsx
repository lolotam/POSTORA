import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { YouTubeCommentsScreen, Stage4RecoveredOperations } from "../ui/YouTubeCommentsScreen";
import type { YouTubeCommentsGateway } from "../application/ports";
import type {
  Stage4CapabilitiesPayload,
  Stage4CommentRow,
  Stage4OperationStatusPayload,
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
  videos?: Array<{ id: string; title: string; published_at?: string | null; thumbnail_url?: string | null }>;
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
        id: v.id,
        title: v.title,
        published_at: v.published_at ?? null,
        thumbnail_url: v.thumbnail_url ?? null,
      })),
      next_cursor: null,
    })),
    threadPage: vi.fn(async () => {
      if (script.threadError) throw new YouTubeCommentsError(script.threadError);
      return {
        account_id: ACCOUNT,
        channel_id: "UC-x",
        binding_generation: 1,
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
      binding_generation: 1,
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
    expect(await screen.findByRole("option", { name: "First upload" })).toBeInTheDocument();
    expect(await screen.findByText("a top-level comment")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Held for review" })).toBeInTheDocument();
  });

  it("renders Studio thumbnails, publish dates, and the active video context", async () => {
    const publishedAt = "2026-01-02T00:00:00Z";
    const thumbnailUrl = "https://img.youtube.com/vi/vid-1/hqdefault.jpg";
    renderScreen({
      videos: [{ id: "vid-1", title: "Studio upload", published_at: publishedAt, thumbnail_url: thumbnailUrl }],
      threads: [row()],
    });
    await screen.findByText("a top-level comment");
    const option = screen.getByRole("option", { name: "Studio upload" });
    expect(option.querySelector("img")).toHaveAttribute("src", thumbnailUrl);
    expect(option).toHaveTextContent(new Date(publishedAt).toLocaleDateString());
    expect(option).toHaveTextContent("Published");
    const activeVideoBar = screen.getByTestId("yt-stage4-active-video-bar");
    expect(activeVideoBar).toHaveTextContent("Studio upload");
    expect(activeVideoBar.querySelector("img")).toHaveAttribute("src", thumbnailUrl);
  });

  it("filters and searches uploads without losing option selection", async () => {
    renderScreen({
      videos: [
        { id: "vid-1", title: "Daily upload" },
        { id: "vid-2", title: "Cooking #Shorts" },
        { id: "vid-3", title: "Studio tutorial" },
        { id: "vid-4", title: "Board shorts haul" },
      ],
      threads: [row()],
    });
    await screen.findByRole("option", { name: "Daily upload" });
    const search = screen.getByTestId("yt-stage4-video-search");
    fireEvent.change(search, { target: { value: "tutorial" } });
    expect(screen.getByRole("option", { name: "Studio tutorial" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Daily upload" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("yt-stage4-video-filter-shorts"));
    const shortsOption = screen.getByRole("option", { name: "Cooking #Shorts" });
    expect(screen.queryByRole("option", { name: "Daily upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Board shorts haul" })).not.toBeInTheDocument();
    fireEvent.click(shortsOption);
    await waitFor(() => expect(shortsOption).toHaveAttribute("aria-selected", "true"));
    fireEvent.change(search, { target: { value: "no matching upload" } });
    expect(screen.getByTestId("yt-stage4-picker-no-match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("option", { name: "Cooking #Shorts" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("yt-stage4-video-filter-videos"));
    expect(screen.getByRole("option", { name: "Daily upload" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Board shorts haul" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Cooking #Shorts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("yt-stage4-video-filter-all"));
    expect(screen.getByRole("option", { name: "Cooking #Shorts" })).toBeInTheDocument();
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
    // published -> Reject only (a published comment cannot return to held:
    // Hold is not offered); heldForReview -> Publish + Reject; null -> none.
    expect(screen.queryByRole("button", { name: "Hold" })).not.toBeInTheDocument();
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

  it("never re-sends an indeterminate operation's key: a new deliberate submit gets its own key", async () => {
    const { calls, gateway } = renderScreen({
      threads: [row()],
      createResult: () => Promise.resolve(receipt({ state: "indeterminate", reason: "indeterminate" })),
      statusResult: Promise.resolve({ state: "indeterminate", reason: null }),
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/);
    fireEvent.change(input, { target: { value: "ghost" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/may or may not have been applied/));
    // The earlier one stays unresolved on the server (its fence guards the
    // original); a different text is a different comment and is not blocked.
    fireEvent.change(input, { target: { value: "a different comment" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(calls.create).toBe(2));
    const keys = (gateway.createThread as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { operationId: string }).operationId);
    expect(new Set(keys).size).toBe(2);
  });

  it("an earlier submit that may still land blocks a new one: the answer is pending, nothing is sent", async () => {
    const { calls } = renderScreen({
      threads: [row()],
      createResult: () => Promise.resolve(receipt({ state: "dispatched" })),
      statusResult: Promise.resolve({ state: "dispatched", reason: null }),
    });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "in flight" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByText(/still being checked/)).toBeInTheDocument());
    expect(calls.create).toBe(1);
  });

  it("a lost response offers a status check that reads and never resends", async () => {
    const { calls, gateway } = renderScreen({
      threads: [row()],
      createResult: () => Promise.reject(new Error("Failed to fetch")),
    });
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "lost" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    });
    await waitFor(() => expect(screen.getAllByRole("status").some((el) => /Accepted by YouTube/.test(el.textContent ?? ""))).toBe(true));
    expect(gateway.operationStatus).toHaveBeenCalledTimes(1);
    expect(calls.create).toBe(1);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toEqual([]));
  });

  it("a receipt still in flight after a reload is pending with a status check, never 'not applied'", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-flight", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
    }]));
    renderScreen({ threads: [row()], statusResult: Promise.resolve({ state: "dispatched", reason: null }) });
    const banner = await screen.findByTestId("yt-stage4-recovered");
    expect(banner).toHaveTextContent(/still being processed/);
    expect(banner).not.toHaveTextContent(/not applied/);
    expect(within(banner).getByRole("button", { name: "Check status" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);
  });

  it("dismissing a recovered indeterminate outcome forgets its identity, so a reload does not bring it back", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-unsure", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now() - 5 * 60_000,
    }]));
    renderScreen({ threads: [row()], statusResult: Promise.resolve({ state: "indeterminate", reason: null }) });
    const banner = await screen.findByTestId("yt-stage4-recovered");
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toEqual([]);
  });

  it("pressing submit after a lost response that became confirmed shows that result first and sends nothing new", async () => {
    const { calls, gateway } = renderScreen({
      threads: [row()],
      createResult: () => Promise.reject(new Error("Failed to fetch")),
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/);
    fireEvent.change(input, { target: { value: "first text" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    // The owner types something else and presses submit: the earlier result (confirmed by now) is shown, nothing is sent.
    fireEvent.change(input, { target: { value: "second text" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByText(/Your earlier action was accepted by YouTube/)).toBeInTheDocument());
    expect(calls.create).toBe(1);
    expect((input as HTMLTextAreaElement).value).toBe("second text");
    // Only the next deliberate submit sends the new text, under a new key.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(calls.create).toBe(2));
    const keys = (gateway.createThread as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { operationId: string }).operationId);
    expect(new Set(keys).size).toBe(2);
  });

  it("a status check of an old receipt never clears text that was typed after it", async () => {
    const { gateway } = renderScreen({
      threads: [row()],
      createResult: () => Promise.reject(new Error("Failed to fetch")),
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/);
    fireEvent.change(input, { target: { value: "sent text" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    fireEvent.change(input, { target: { value: "typed after the failure" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    });
    await waitFor(() => expect(gateway.operationStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("status").some((el) => /Accepted by YouTube/.test(el.textContent ?? ""))).toBe(true));
    expect((input as HTMLTextAreaElement).value).toBe("typed after the failure");
  });

  it("a late status result never overwrites newer composer work", async () => {
    let releaseStatus!: () => void;
    const { gateway, calls } = renderScreen({
      threads: [row()],
      createResult: () => Promise.reject(new Error("Failed to fetch")),
    });
    let statusCalls = 0;
    (gateway.operationStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      statusCalls += 1;
      // The first read (the check) stays pending; the pre-submit read of the next submit answers at once, unresolved.
      if (statusCalls === 1) await new Promise<void>((resolve) => { releaseStatus = resolve; });
      return {
        operation_id: "op-x", action: "create_thread", state: statusCalls === 1 ? "refused" : "indeterminate", reason: statusCalls === 1 ? "possible_duplicate" : null, provider_class: null,
        moderation_status: null, ban_requested: false, result_thread_id: null, result_comment_id: null,
        binding_generation: 1, channel_id: "UC-x", observation: null, observed_text: null,
      };
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/);
    fireEvent.change(input, { target: { value: "one" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    // A check starts and is still pending...
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    });
    // ...the owner submits again meanwhile: its own answer is what the composer shows.
    (gateway.createThread as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      calls.create += 1;
      return receipt();
    });
    fireEvent.change(input, { target: { value: "two" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Comment$/ }));
    });
    await waitFor(() => expect(screen.getAllByRole("status").some((el) => /Accepted by YouTube/.test(el.textContent ?? ""))).toBe(true));
    await act(async () => { releaseStatus(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.queryByText(/may already be on its way/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").some((el) => /Accepted by YouTube/.test(el.textContent ?? ""))).toBe(true);
  });

  it("a moderation that finishes after its dialog was cancelled and reopened leaves the reopened dialog open", async () => {
    let releaseModerate!: () => void;
    const { gateway } = renderScreen({ caps: capabilities({ ban: true }), threads: [row()] });
    (gateway.moderate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseModerate = resolve; });
      return receipt({ action: "moderate", moderation_status: "rejected" });
    });
    await screen.findByText("a top-level comment");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByRole("checkbox", { name: "Also ban this author" });
    // The plain Reject is in flight; the dialog is cancelled and opened again.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).find((button) => button.closest("[role=dialog]")) as HTMLElement);
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Also ban this author" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByRole("checkbox", { name: "Also ban this author" });
    await act(async () => { releaseModerate(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(screen.getByRole("checkbox", { name: "Also ban this author" })).toBeInTheDocument();
  });

  it("a list reload that lands while replies are open keeps them open (handles are re-sealed on every load)", async () => {
    const { gateway } = makeGateway({
      replies: [row({ kind: "reply", comment_id: "c-reply-1", handle: "hdl-reply-1", canonical_parent_id: "c-stable", text: "reply page one" })],
    });
    let loads = 0;
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      loads += 1;
      return {
        account_id: ACCOUNT, channel_id: "UC-x", video_id: "vid-1", list: "published" as const,
        // The same comment on every load, under a NEW sealed handle each time.
        items: [row({ comment_id: "c-stable", handle: `hdl-load-${loads}`, text: `stable thread (load ${loads})` })],
        next_cursor: null, inconsistent_count: 0,
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("stable thread (load 1)");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    expect(await screen.findByText("reply page one")).toBeInTheDocument();
    // A reload (what a confirmed write triggers) completes: the owner sees the replies they opened, not a collapsed thread.
    const replyPage = gateway.replyPage as ReturnType<typeof vi.fn>;
    const replyCallsBefore = replyPage.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    // The replacement row is what proves the reload COMMITTED: the load counter alone moves when the mock merely starts.
    await screen.findByText("stable thread (load 2)");
    expect(screen.queryByText("stable thread (load 1)")).not.toBeInTheDocument();
    expect(screen.getByTestId("yt-stage4-replies")).toBeInTheDocument();
    // The reply page was read again EXACTLY once (a handle-keyed entry would have restarted it, and an
    // unrefreshed cache would not have read at all), with the new handle as request data, from page one.
    await waitFor(() => expect(replyPage.mock.calls.length).toBe(replyCallsBefore + 1));
    expect(replyPage.mock.calls.at(-1)?.[0]).toMatchObject({ parentHandle: "hdl-load-2" });
    expect((replyPage.mock.calls.at(-1)?.[0] as { cursor?: string | null }).cursor ?? null).toBeNull();
    expect(await screen.findByText("reply page one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load replies" })).not.toBeInTheDocument();
  });

  it("each thread in the Held list says so when none of ITS rows is held", async () => {
    renderScreen({
      threads: [
        row({ comment_id: "c-a", handle: "hdl-a", moderation_status: "heldForReview", text: "held thread" }),
        row({ comment_id: "c-b", handle: "hdl-b", moderation_status: "published", text: "plain thread" }),
      ],
    });
    await screen.findByText("plain thread");
    fireEvent.click(screen.getByRole("tab", { name: "Held for review" }));
    await screen.findByText("plain thread");
    // One notice, for the thread with no held row; the thread that has one is not silenced by it, nor does it silence the other.
    await waitFor(() => expect(screen.getAllByTestId("yt-stage4-held-hidden")).toHaveLength(1));
  });

  it("refreshes the comment list on request, apart from the uploads", async () => {
    const { gateway } = renderScreen({ threads: [row()] });
    await screen.findByText("a top-level comment");
    const before = (gateway.threadPage as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await waitFor(() => expect((gateway.threadPage as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before));
  });

  it("gives every composer its own input id, so a label reaches its own textarea", async () => {
    renderScreen({ threads: [row()] });
    await screen.findByText("a top-level comment");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const reply = await screen.findByLabelText("Write a reply");
    const top = screen.getByLabelText(/Post a comment as your channel/);
    expect(reply).not.toBe(top);
    expect(reply.id).not.toBe(top.id);
  });

  describe("the ban step", () => {
    it("locks the box while the confirmation is pending and never downgrades to a plain reject", async () => {
      const { gateway, calls } = renderScreen({ caps: capabilities({ ban: true }), threads: [row()] });
      let release!: () => void;
      (gateway.banConfirmation as ReturnType<typeof vi.fn>).mockImplementation(async (params: { operationId: string }) => {
        calls.banKeys.push(params.operationId);
        await new Promise<void>((resolve) => { release = resolve; });
        return { confirmation: "bnc-server-token", expires_in_seconds: 120, author_channel_id: "UC-author-1", author_name: "Author One" };
      });
      await screen.findByText("a top-level comment");
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      const box = await screen.findByRole("checkbox", { name: "Also ban this author" });
      fireEvent.click(box);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      });
      expect(box).toBeDisabled();
      await act(async () => { release(); });
      const confirm = await screen.findByRole("button", { name: "Reject and ban" });
      await act(async () => {
        fireEvent.click(confirm);
      });
      await waitFor(() => expect(calls.moderate).toHaveLength(1));
      expect(calls.moderate[0]).toMatchObject({ status: "rejected", banConfirmation: "bnc-server-token" });
      expect(calls.moderateKeys[0]).toBe(calls.banKeys[0]);
    });

    it("ignores a confirmation that answers after the dialog was closed and reopened", async () => {
      const { gateway, calls } = renderScreen({ caps: capabilities({ ban: true }), threads: [row()] });
      let release!: () => void;
      (gateway.banConfirmation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { confirmation: "bnc-stale-token", expires_in_seconds: 120, author_channel_id: "UC-author-1", author_name: "Author One" };
      });
      await screen.findByText("a top-level comment");
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      fireEvent.click(await screen.findByRole("checkbox", { name: "Also ban this author" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      await screen.findByRole("checkbox", { name: "Also ban this author" });
      await act(async () => { release(); });
      // The reopened dialog is still on its first step, and no ban step can submit.
      expect(screen.queryByRole("button", { name: "Reject and ban" })).not.toBeInTheDocument();
      expect(calls.moderate).toHaveLength(0);
    });
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
      createdAt: Date.now() - 10 * 60_000,
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

describe("YouTubeCommentsScreen follow-up (Stage 4 issue 470)", () => {
  const storedOps = () => JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]") as Array<{ operationId: string }>;

  it("a blocked submit never lets a later confirmation clear the unsent draft", async () => {
    // Submit A loses its response; the owner types B and submits (blocked: A is still pending); the
    // status check then confirms A. B was never sent, so it must stay in the box.
    const { gateway, calls } = renderScreen({ threads: [row()], createResult: () => Promise.reject(new Error("Failed to fetch")) });
    const status = gateway.operationStatus as ReturnType<typeof vi.fn>;
    const answer = (state: "dispatched" | "confirmed") => ({
      operation_id: "op-x", action: "create_thread", state, reason: null, provider_class: null, moderation_status: null,
      ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: 1, channel_id: "UC-x",
      observation: null, observed_text: null,
    });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "text A" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Comment$/ })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    // The pre-submit check finds A still pending.
    status.mockResolvedValueOnce(answer("dispatched"));
    fireEvent.change(input, { target: { value: "text B" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Comment$/ })); });
    await waitFor(() => expect(screen.getByText(/still being checked/)).toBeInTheDocument());
    expect(calls.create).toBe(1);
    expect(input.value).toBe("text B");
    // Confirming A through "Check status" must not clear B.
    status.mockResolvedValueOnce(answer("confirmed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    await waitFor(() => expect(screen.getAllByRole("status").some((el) => /Accepted by YouTube/.test(el.textContent ?? ""))).toBe(true));
    expect(input.value).toBe("text B");
  });

  it("confirming the operation that WAS sent still clears the box when it holds that text", async () => {
    const { gateway } = renderScreen({ threads: [row()], createResult: () => Promise.reject(new Error("Failed to fetch")) });
    await screen.findByTestId("yt-stage4-composer");
    const input = screen.getByLabelText(/Post a comment as your channel/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "text A" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Comment$/ })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    await waitFor(() => expect(input.value).toBe(""));
    expect(gateway.operationStatus).toHaveBeenCalledTimes(1);
  });

  it("a Refresh reads the open reply page again with the CURRENT handle, and keeps the rows and the reply draft", async () => {
    // Changed from "nothing is refetched": the first reply page is now read again on every Refresh, because
    // a cached page can be older than the thread. What must NOT change: the thread stays open, the
    // composer inside it keeps its draft, and the new handle is request data only.
    const { gateway } = makeGateway({});
    let loads = 0;
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      loads += 1;
      return {
        account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, video_id: "vid-1", list: "published" as const,
        items: [row({ comment_id: "c-stable", handle: `hdl-load-${loads}`, text: `stable thread load ${loads}` })],
        next_cursor: null, inconsistent_count: 0,
      };
    });
    (gateway.replyPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, parent_handle: "hdl-any",
      items: [row({ kind: "reply", comment_id: "c-reply-1", handle: "hdl-reply-1", canonical_parent_id: "c-stable", text: "reply page one" })],
      next_cursor: null, inconsistent_count: 0,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("stable thread load 1");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await screen.findByText("reply page one");
    fireEvent.click(within(screen.getByTestId("yt-stage4-replies")).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(screen.getByTestId("yt-stage4-replies")).getByLabelText("Write a reply"), { target: { value: "half-written reply" } });
    const replyPage = gateway.replyPage as ReturnType<typeof vi.fn>;
    const before = replyPage.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await screen.findByText("stable thread load 2");
    await waitFor(() => expect(replyPage.mock.calls.length).toBe(before + 1));

    const last = replyPage.mock.calls.at(-1)?.[0] as { parentHandle: string; cursor?: string | null };
    expect(last.parentHandle).toBe("hdl-load-2");
    expect(last.cursor ?? null).toBeNull();
    expect(screen.getByText("reply page one")).toBeInTheDocument();
    expect((within(screen.getByTestId("yt-stage4-replies")).getByLabelText("Write a reply") as HTMLTextAreaElement).value).toBe("half-written reply");
  });

  it("a confirmed edit of a reply shows the new text even when an older reply page is cached", async () => {
    const { gateway } = makeGateway({});
    let edited = false;
    const reply = (text: string) => row({ kind: "reply", comment_id: "c-mine-reply", handle: `hdl-r-${text}`, canonical_parent_id: "c-parent", text, is_own: true });
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, video_id: "vid-1", list: "published" as const,
      items: [row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" }), reply(edited ? "reply AFTER edit" : "reply BEFORE edit")],
      next_cursor: null, inconsistent_count: 0,
    }));
    // The reply page answers the old text until the edit has happened, then the new text.
    (gateway.replyPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, parent_handle: "hdl-parent",
      items: [reply(edited ? "reply AFTER edit" : "reply BEFORE edit")], next_cursor: null, inconsistent_count: 0,
    }));
    (gateway.edit as ReturnType<typeof vi.fn>).mockImplementation(async () => { edited = true; return receipt({ action: "edit" }); });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("the parent");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await waitFor(() => expect(within(screen.getByTestId("yt-stage4-replies")).getByText("reply BEFORE edit")).toBeInTheDocument());
    const replies = within(screen.getByTestId("yt-stage4-replies"));
    fireEvent.click(replies.getByRole("button", { name: "Edit" }));
    fireEvent.change(replies.getByLabelText("Edit your comment"), { target: { value: "reply AFTER edit" } });
    await act(async () => { fireEvent.click(replies.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getAllByText("reply AFTER edit").length).toBeGreaterThan(0));
    expect(screen.queryByText("reply BEFORE edit")).not.toBeInTheDocument();
  });

  it("the thread page's own copy of a reply wins over an older cached reply page", async () => {
    const { gateway } = makeGateway({});
    let loads = 0;
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      loads += 1;
      return {
        account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, video_id: "vid-1", list: "published" as const,
        items: [
          row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" }),
          row({ kind: "reply", comment_id: "c-r", handle: "hdl-r", canonical_parent_id: "c-parent", text: loads === 1 ? "inline OLD" : "inline NEW" }),
        ],
        next_cursor: null, inconsistent_count: 0,
      };
    });
    // The reply page is stuck on the OLD text for the whole test.
    (gateway.replyPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, parent_handle: "hdl-parent",
      items: [row({ kind: "reply", comment_id: "c-r", handle: "hdl-r", canonical_parent_id: "c-parent", text: "inline OLD" })],
      next_cursor: null, inconsistent_count: 0,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("the parent");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await screen.findByText("inline OLD");
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await screen.findByText("inline NEW");
    expect(screen.queryByText("inline OLD")).not.toBeInTheDocument();
  });

  it("a change of the binding generation drops the old reply chain and starts again from page one", async () => {
    const { gateway } = makeGateway({});
    let generation = 1;
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: generation, video_id: "vid-1", list: "published" as const,
      items: [row({ comment_id: "c-parent", handle: `hdl-parent-g${generation}`, text: `parent g${generation}` })],
      next_cursor: null, inconsistent_count: 0,
    }));
    (gateway.replyPage as ReturnType<typeof vi.fn>).mockImplementation(async (params: { cursor?: string | null }) => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: generation, parent_handle: "hdl-any",
      items: [row({ kind: "reply", comment_id: params.cursor ? "c-r2" : "c-r1", handle: "h", canonical_parent_id: "c-parent", text: params.cursor ? "second page reply" : "first page reply" })],
      next_cursor: params.cursor ? null : "cursor-g1", inconsistent_count: 0,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("parent g1");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    fireEvent.click(await screen.findByRole("button", { name: "More replies" }));
    await screen.findByText("second page reply");
    // The channel is reconnected: the next list load carries a new generation.
    generation = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await screen.findByText("parent g2");
    await screen.findByText("first page reply");
    await waitFor(() => expect(screen.queryByText("second page reply")).not.toBeInTheDocument());
    const replyPage = gateway.replyPage as ReturnType<typeof vi.fn>;
    // The cursor of generation 1 was never sent again.
    expect(replyPage.mock.calls.filter((call) => (call[0] as { cursor?: string | null }).cursor === "cursor-g1")).toHaveLength(1);
    expect(client.getQueryCache().find({ queryKey: ["youtube-comments", USER, ACCOUNT, "replies:c-parent:g2", "page-0"] })).toBeDefined();
  });

  it("a refused stale cursor offers a reload from page one, not the same request again, and keeps the draft", async () => {
    const { gateway } = makeGateway({});
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, video_id: "vid-1", list: "published" as const,
      items: [row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" })],
      next_cursor: null, inconsistent_count: 0,
    }));
    (gateway.replyPage as ReturnType<typeof vi.fn>).mockImplementation(async (params: { cursor?: string | null }) => {
      if (params.cursor) throw new YouTubeCommentsError("invalid_handle");
      return {
        account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, parent_handle: "hdl-parent",
        items: [row({ kind: "reply", comment_id: "c-r1", handle: "h1", canonical_parent_id: "c-parent", text: "first page reply" })],
        next_cursor: "cursor-old", inconsistent_count: 0,
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("the parent");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await screen.findByText("first page reply");
    fireEvent.click(within(screen.getByTestId("yt-stage4-replies")).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(screen.getByTestId("yt-stage4-replies")).getByLabelText("Write a reply"), { target: { value: "draft survives" } });
    fireEvent.click(screen.getByRole("button", { name: "More replies" }));
    const reload = await screen.findByRole("button", { name: "Reload from the start" });
    expect(screen.queryByRole("button", { name: "Retry this page" })).not.toBeInTheDocument();
    const replyPage = gateway.replyPage as ReturnType<typeof vi.fn>;
    const before = replyPage.mock.calls.length;
    fireEvent.click(reload);
    await waitFor(() => expect(replyPage.mock.calls.length).toBe(before + 1));
    expect((replyPage.mock.calls.at(-1)?.[0] as { cursor?: string | null }).cursor ?? null).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reload from the start" })).not.toBeInTheDocument());
    expect((within(screen.getByTestId("yt-stage4-replies")).getByLabelText("Write a reply") as HTMLTextAreaElement).value).toBe("draft survives");
  });

  it("a status check that compared the edit text shows that result apart from the receipt state", async () => {
    const { gateway } = renderScreen({
      threads: [row({ comment_id: "c-mine", handle: "hdl-mine", text: "my comment", is_own: true })],
    });
    (gateway.edit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Failed to fetch"));
    (gateway.operationStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      operation_id: "op-x", action: "edit", state: "indeterminate", reason: "no_settlement", provider_class: null, moderation_status: null,
      ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: 1, channel_id: "UC-x",
      observation: "requested_text_observed", observed_text: "my edited comment",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit your comment"), { target: { value: "my edited comment" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    expect(await screen.findByTestId("yt-stage4-observation")).toHaveTextContent("YouTube currently shows the text you asked for.");
    expect(screen.getByRole("alert")).toHaveTextContent(/may or may not have been applied/);
  });

  it("earlier pages of a list keep an observer for as long as the list is mounted", async () => {
    const { gateway } = makeGateway({});
    (gateway.threadPage as ReturnType<typeof vi.fn>).mockImplementation(async (params: { cursor?: string | null }) => ({
      account_id: ACCOUNT, channel_id: "UC-x", video_id: "vid-1", list: "published" as const,
      items: [params.cursor ? row({ comment_id: "c-p2", text: "second page row" }) : row({ comment_id: "c-p1", text: "first page row" })],
      next_cursor: params.cursor ? null : "cursor-2", inconsistent_count: 0,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("first page row");
    fireEvent.click(await screen.findByRole("button", { name: "Load more comments" }));
    await screen.findByText("second page row");
    const firstPage = client.getQueryCache().find({ queryKey: ["youtube-comments", USER, ACCOUNT, "threads:vid-1:published", "page-0"] });
    expect(firstPage).toBeDefined();
    // An entry nobody observes is garbage-collected after ten minutes and the list would lose its first rows.
    expect(firstPage!.getObserversCount()).toBeGreaterThan(0);
    expect(screen.getByText("first page row")).toBeInTheDocument();
  });

  it("a failed settings refresh keeps the admitted screen and offers a retry", async () => {
    const { gateway } = makeGateway({ threads: [row()] });
    const caps = gateway.capabilities as ReturnType<typeof vi.fn>;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    await screen.findByText("a top-level comment");
    caps.mockRejectedValueOnce(new YouTubeCommentsError("upstream"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["youtube-comments", USER, ACCOUNT, "capabilities", null] }); });
    const banner = await screen.findByTestId("yt-stage4-settings-error");
    expect(screen.getByText("a top-level comment")).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("yt-stage4-settings-error")).not.toBeInTheDocument());
    expect(screen.getByText("a top-level comment")).toBeInTheDocument();
  });

  it("a first load that fails to read the settings says so and offers a retry, never 'not enabled'", async () => {
    const { gateway } = makeGateway({ threads: [row()] });
    (gateway.capabilities as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new YouTubeCommentsError("upstream"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Postora could not read its settings")).toBeInTheDocument();
    expect(screen.queryByText(/not enabled for this channel/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("a top-level comment")).toBeInTheDocument();
  });

  it("the manual status check sends the draft of an edit for reconciliation", async () => {
    const { gateway } = renderScreen({
      threads: [row({ comment_id: "c-mine", handle: "hdl-mine", text: "my comment", is_own: true })],
    });
    (gateway.edit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Failed to fetch"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Edit your comment") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "my edited comment" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    const lastCall = (gateway.operationStatus as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { text?: string };
    expect(lastCall.text).toBe("my edited comment");
  });

  it("a manual status check right after a submit keeps the identity when the receipt is not there yet (pre-claim grace)", async () => {
    const { gateway } = renderScreen({ threads: [row()], createResult: () => Promise.reject(new Error("Failed to fetch")) });
    (gateway.operationStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new YouTubeCommentsError("not_found"));
    await screen.findByTestId("yt-stage4-composer");
    fireEvent.change(screen.getByLabelText(/Post a comment as your channel/), { target: { value: "fresh" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Comment$/ })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    // Still the "lost answer" line with its check button, not "reconnected": the receipt may simply not exist yet.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    expect(screen.getByRole("alert")).not.toHaveTextContent(/reconnected/);
    expect(storedOps()).toHaveLength(1);
  });

  it("dismissing a banner while its re-check is in flight does not acknowledge the receipt", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-flight", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
    }]));
    const { gateway } = makeGateway({ threads: [row()], statusResult: Promise.resolve({ state: "dispatched", reason: null }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
      </QueryClientProvider>,
    );
    const banner = await screen.findByTestId("yt-stage4-recovered");
    // The re-check resolves only when the test lets it, and it will then say "confirmed".
    let release: (value: Stage4OperationStatusPayload) => void = () => undefined;
    (gateway.operationStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Stage4OperationStatusPayload>((resolve) => { release = resolve; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Check status" }));
    await waitFor(() => expect((gateway.operationStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      release({
        operation_id: "op-flight", action: "create_thread", state: "confirmed", reason: null, provider_class: null, moderation_status: null,
        ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: 1, channel_id: "UC-x",
        observation: null, observed_text: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // The owner dismissed the banner before it showed the outcome, so the identity is still there for the next view.
    expect(storedOps()).toHaveLength(1);
  });
});

describe("Stage4RecoveredOperations (standalone recovery) follow-up", () => {
  it("dismissing a banner while its re-check is in flight does not acknowledge the receipt", async () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, JSON.stringify([{
      operationId: "op-flight", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
    }]));
    const { gateway } = makeGateway({ statusResult: Promise.resolve({ state: "dispatched", reason: null }) });
    render(<Stage4RecoveredOperations userId={USER} accountId={ACCOUNT} gateway={gateway} />);
    const banner = await screen.findByTestId("yt-stage4-recovered-standalone");
    let release: (value: Stage4OperationStatusPayload) => void = () => undefined;
    (gateway.operationStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Stage4OperationStatusPayload>((resolve) => { release = resolve; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Check status" }));
    await waitFor(() => expect((gateway.operationStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      release({
        operation_id: "op-flight", action: "create_thread", state: "confirmed", reason: null, provider_class: null, moderation_status: null,
        ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: 1, channel_id: "UC-x",
        observation: null, observed_text: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(JSON.parse(localStorage.getItem(`postora:yt-stage4:ops:${USER}`) ?? "[]")).toHaveLength(1);
  });
});
