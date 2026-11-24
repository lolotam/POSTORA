// Stage 4 follow-up PR 2 — the pre-submit guard and duplicate-row freshness.
//
//   G1  with browser storage blocked, the guard still sees the operation held
//       only in memory and reads its status instead of minting a second edit;
//   F1  when two loaded pages carry the same comment key, the copy read last
//       (the greater dataUpdatedAt) wins, whatever page it came from.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeCommentsScreen } from "../ui/YouTubeCommentsScreen";
import { useStage4Replies } from "../application/useYouTubeStage4";
import { youtubeCommentsKey } from "../application/queryKeys";
import type { YouTubeCommentsGateway } from "../application/ports";
import type {
  Stage4CapabilitiesPayload,
  Stage4CommentRow,
  Stage4OperationStatusPayload,
  Stage4ReceiptPayload,
} from "../domain/types";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function capabilities(): Stage4CapabilitiesPayload {
  const on = { allowed: true, reason: null };
  return { account_id: ACCOUNT, capabilities: { read: on, held: on, write: on, ban: { allowed: false, reason: "capability_off" } } };
}

function ownRow(): Stage4CommentRow {
  return {
    handle: "hdl-mine",
    kind: "thread",
    comment_id: "c-mine",
    thread_id: "t-1",
    video_id: "vid-1",
    canonical_parent_id: "",
    author_channel_id: "UC-own",
    author_name: "Own channel",
    author_avatar_url: null,
    text: "my comment",
    published_at: "2026-01-02T00:00:00Z",
    like_count: 0,
    moderation_status: "published",
    is_own: true,
  };
}

function status(state: Stage4OperationStatusPayload["state"], overrides: Partial<Stage4OperationStatusPayload> = {}): Stage4OperationStatusPayload {
  return {
    operation_id: "op-x",
    action: "edit",
    state,
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
    ...overrides,
  };
}

function receipt(): Stage4ReceiptPayload {
  return { ...status("confirmed") } as Stage4ReceiptPayload;
}

function makeGateway(overrides: Partial<YouTubeCommentsGateway> = {}): YouTubeCommentsGateway {
  return {
    capabilities: vi.fn(async () => capabilities()),
    videoPage: vi.fn(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x",
      items: [{ id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null }],
      next_cursor: null,
    })),
    threadPage: vi.fn(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, video_id: "vid-1", list: "published" as const,
      items: [ownRow()], next_cursor: null, inconsistent_count: 0,
    })),
    replyPage: vi.fn(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: 1, parent_handle: "hdl-any", items: [], next_cursor: null, inconsistent_count: 0,
    })),
    createThread: vi.fn(async () => receipt()),
    reply: vi.fn(async () => receipt()),
    edit: vi.fn(async () => receipt()),
    banConfirmation: vi.fn(),
    deleteOwnComment: vi.fn(),
    moderate: vi.fn(async () => receipt()),
    operationStatus: vi.fn(async () => status("confirmed")),
    ...overrides,
  } as unknown as YouTubeCommentsGateway;
}

function withClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("G1: the guard also sees an operation storage could not keep", () => {
  it("a second Save of a lost edit reads the first operation's status and never sends a second edit", async () => {
    const gateway = makeGateway();
    const edit = gateway.edit as ReturnType<typeof vi.fn>;
    const operationStatus = gateway.operationStatus as ReturnType<typeof vi.fn>;
    // The first edit reaches YouTube but its answer is lost in transport.
    edit.mockRejectedValueOnce(new Error("Failed to fetch"));

    render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = () => screen.getByLabelText("Edit your comment") as HTMLTextAreaElement;
    fireEvent.change(editor(), { target: { value: "first text" } });

    // A locked-down browser: nothing reaches storage, only the in-memory map knows the operation.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    const firstOperationId = (edit.mock.calls[0][0] as { operationId: string }).operationId;
    expect(operationStatus).not.toHaveBeenCalled();

    fireEvent.change(editor(), { target: { value: "second text" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(edit).toHaveBeenCalledTimes(1);
    expect(operationStatus.mock.calls.map((call) => (call[0] as { operationId: string }).operationId)).toContain(firstOperationId);
  });
});

describe("F1: a duplicate row keeps the copy read last", () => {
  it("page one refetched later wins over an older copy of the same key on page two", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const resource = "replies:c-parent:g1";
    const firstPageKey = youtubeCommentsKey(USER, ACCOUNT, resource, "page-0");
    const secondPageKey = youtubeCommentsKey(USER, ACCOUNT, resource, "cur-2");
    const replyRow = (text: string): Stage4CommentRow => ({ ...ownRow(), kind: "reply", comment_id: "c-dup", handle: "hdl-dup", canonical_parent_id: "c-parent", text });

    // Page two holds an OLDER read of the same comment key.
    client.setQueryData(secondPageKey, {
      page: [{ key: "c-dup", row: replyRow("OLDER page two text") }],
      next: null,
      stale: false,
    }, { updatedAt: 100 });
    // Page one was refetched later: newer text and a NEWER read time.
    client.setQueryData(firstPageKey, {
      page: [{ key: "c-dup", row: replyRow("NEWER page one text") }],
      next: "cur-2",
      stale: false,
    }, { updatedAt: 200 });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useStage4Replies({
      userId: USER,
      accountId: ACCOUNT,
      gateway: makeGateway(),
      parentCommentId: "c-parent",
      parentHandle: "hdl-parent",
      bindingGeneration: 1,
      refreshEpoch: 0,
      // The pages are supplied from the cache above; no network read may move their dataUpdatedAt.
      enabled: false,
    }), { wrapper });

    act(() => result.current.loadMore());
    expect(result.current.items.map((item) => item.row.text)).toEqual(["NEWER page one text"]);
  });
});
