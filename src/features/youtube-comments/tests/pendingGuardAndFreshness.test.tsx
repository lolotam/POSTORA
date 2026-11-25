// Stage 4 follow-up PR 2 — the pre-submit guard and duplicate-row freshness.
//
//   G1  with browser storage blocked, the guard still sees the operation held
//       only in memory and reads its status instead of minting a second edit;
//   F1  when two loaded pages carry the same comment key, the copy read last
//       (the greater dataUpdatedAt) wins, whatever page it came from;
//   T1  a settled identity leaves the in-memory guard even when storage is blocked;
//   T2  one submit per target: a second click while the first reads status sends nothing.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeCommentsScreen } from "../ui/YouTubeCommentsScreen";
import { useStage4Replies, useYouTubeStage4 } from "../application/useYouTubeStage4";
import { youtubeCommentsKey } from "../application/queryKeys";
import { YouTubeCommentsError } from "../domain/errors";
import { savePendingOperation } from "../domain/operationIdentity";
import type { YouTubeCommentsGateway } from "../application/ports";
import type {
  Stage4CapabilitiesPayload,
  Stage4CommentRow,
  Stage4OperationStatusPayload,
  Stage4ReceiptPayload,
} from "../domain/types";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const STORE_KEY = `postora:yt-stage4:ops:${USER}`;

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

function childRow(): Stage4CommentRow {
  return {
    ...ownRow(),
    handle: "hdl-child",
    kind: "reply",
    comment_id: "c-child",
    canonical_parent_id: "c-mine",
    is_own: false,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storedOperations(): Array<{ operationId: string; targetCommentId: string; targetIsCanonicalParent?: boolean }> {
  return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Array<{
    operationId: string;
    targetCommentId: string;
    targetIsCanonicalParent?: boolean;
  }>;
}

function seedEarlierOperation(action: "edit" | "reply" = "edit") {
  savePendingOperation(USER, {
    operationId: "op-earlier",
    accountId: ACCOUNT,
    videoId: "vid-1",
    action,
    targetCommentId: "c-mine",
    createdAt: Date.now(),
  });
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

describe("T1: a settled identity leaves the in-memory guard", () => {
  it("a terminal not_found under blocked storage is not re-read on the next Save", async () => {
    const gateway = makeGateway();
    const edit = gateway.edit as ReturnType<typeof vi.fn>;
    const operationStatus = gateway.operationStatus as ReturnType<typeof vi.fn>;
    // The first edit reaches YouTube but its answer is lost in transport.
    edit.mockRejectedValueOnce(new Error("Failed to fetch"));

    render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = () => screen.getByLabelText("Edit your comment") as HTMLTextAreaElement;
    fireEvent.change(editor(), { target: { value: "first text" } });

    // Nothing reaches storage, so the in-memory identity is the only one held.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    const firstOperationId = edit.mock.calls[0][0] as { operationId: string };
    const operationIds = () => operationStatus.mock.calls.map((call) => (call[0] as { operationId: string }).operationId);

    // The old operation is now old enough that not_found is final, not a pre-claim miss.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 200_000);
    operationStatus.mockImplementation(async (params: { operationId: string }) => {
      if (params.operationId === firstOperationId.operationId) throw new YouTubeCommentsError("not_found");
      return status("confirmed");
    });
    operationStatus.mockClear();

    // This Save reads the old id once, clears it, and sends a new edit.
    fireEvent.change(editor(), { target: { value: "second text" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(operationIds()).toContain(firstOperationId.operationId);

    // The next Save must not be guarded by the old id a second time.
    operationStatus.mockClear();
    fireEvent.change(editor(), { target: { value: "third text" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(operationIds()).not.toContain(firstOperationId.operationId);
    expect(edit).toHaveBeenCalledTimes(3);
  });
});

describe("T2: one submit per target", () => {
  it("a second click while the first waits on a status read is answered pending and sends nothing", async () => {
    const confirmation = deferred<Stage4OperationStatusPayload>();
    const operationStatus = vi.fn(() => confirmation.promise);
    const gateway = makeGateway({ operationStatus });
    const edit = gateway.edit as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    // Seed the earlier operation after mount so the recovery effect does not read it.
    savePendingOperation(USER, {
      operationId: "op-earlier",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "edit",
      targetCommentId: "c-mine",
      createdAt: Date.now(),
    });

    let firstOutcome: unknown = null;
    let secondOutcome: unknown = null;
    await act(async () => {
      // The first click is inside recoverOperation(); the second must not start another.
      const first = result.current.editComment("vid-1", ownRow(), "first");
      const second = result.current.editComment("vid-1", ownRow(), "second");
      confirmation.resolve(status("claimed"));
      firstOutcome = await first;
      secondOutcome = await second;
    });

    expect(firstOutcome).toEqual({ kind: "pending", operationId: "op-earlier" });
    expect(secondOutcome).toEqual({ kind: "pending" });
    expect(operationStatus).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });
});


describe("canonical-parent reply guarding", () => {
  it.each(["parent-then-child", "child-then-parent"] as const)(
    "overlapping replies share one guard and send once: %s",
    async (order) => {
      const response = deferred<Stage4ReceiptPayload>();
      const gateway = makeGateway({ reply: vi.fn(() => response.promise) });
      const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
      const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
        wrapper: ({ children }) => withClient(children),
      });
      const rows = order === "parent-then-child" ? [ownRow(), childRow()] : [childRow(), ownRow()];
      let firstOutcome: unknown = null;
      let secondOutcome: unknown = null;

      await act(async () => {
        const first = result.current.reply("vid-1", rows[0], "first reply");
        const second = result.current.reply("vid-1", rows[1], "second reply");
        secondOutcome = await second;
        response.resolve(receipt());
        firstOutcome = await first;
      });

      const sent = replyMock.mock.calls[0][0] as { operationId: string; targetHandle: string };
      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(sent.targetHandle).toBe(rows[0].handle);
      expect(firstOutcome).toMatchObject({ kind: "confirmed", operationId: sent.operationId });
      expect(secondOutcome).toEqual({ kind: "pending", operationId: sent.operationId });
      expect(storedOperations()).toEqual([expect.objectContaining({
        operationId: sent.operationId,
        targetCommentId: "c-mine",
      })]);
    },
  );

  it("a lost reply sent from a child row guards a later reply from its parent row", async () => {
    const gateway = makeGateway({
      operationStatus: vi.fn(async () => status("claimed", { action: "reply" })),
    });
    const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
    replyMock.mockRejectedValueOnce(new Error("Failed to fetch"));
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    let lostOutcome: unknown = null;
    let guardedOutcome: unknown = null;

    await act(async () => {
      lostOutcome = await result.current.reply("vid-1", childRow(), "reply from the child row");
    });
    const sent = replyMock.mock.calls[0][0] as { operationId: string };
    await act(async () => {
      guardedOutcome = await result.current.reply("vid-1", ownRow(), "reply from the parent row");
    });

    expect(lostOutcome).toMatchObject({ kind: "error", operationId: sent.operationId });
    expect(guardedOutcome).toEqual({ kind: "pending", operationId: sent.operationId });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(storedOperations()).toEqual([expect.objectContaining({
      operationId: sent.operationId,
      targetCommentId: "c-mine",
    })]);
  });

  it("recovers a legacy child-keyed pending reply before sending on its parent thread", async () => {
    const gateway = makeGateway({
      operationStatus: vi.fn(async () => status("claimed", { operation_id: "op-legacy-child", action: "reply" })),
    });
    const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    savePendingOperation(USER, {
      operationId: "op-legacy-child",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "reply",
      targetCommentId: "c-child",
      createdAt: Date.now(),
    });

    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.reply("vid-1", ownRow(), "reply after deploy");
    });

    expect(outcome).toEqual({ kind: "pending", operationId: "op-legacy-child" });
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("an unloaded canonical reply record for another thread does not block this thread", async () => {
    const gateway = makeGateway();
    const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
    const operationStatus = gateway.operationStatus as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    savePendingOperation(USER, {
      operationId: "op-other-thread",
      accountId: ACCOUNT,
      videoId: "vid-1",
      action: "reply",
      targetCommentId: "c-unloaded-thread",
      targetIsCanonicalParent: true,
      createdAt: Date.now(),
    });

    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.reply("vid-1", ownRow(), "reply to unrelated thread");
    });

    expect(outcome).toMatchObject({ kind: "confirmed" });
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(operationStatus).not.toHaveBeenCalled();
  });

  it("Issue #485: a child reply without a canonical parent keeps its child key, guards its loaded thread, and does not block unrelated threads", async () => {
    const childWithoutParent = { ...childRow(), canonical_parent_id: "" };
    const otherThread: Stage4CommentRow = {
      ...ownRow(),
      handle: "hdl-other",
      comment_id: "c-other",
      thread_id: "t-other",
    };
    const response = deferred<Stage4ReceiptPayload>();
    const unrelatedReceipt = receipt();
    const replyMock = vi.fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce(unrelatedReceipt);
    const gateway = makeGateway({
      reply: replyMock,
      operationStatus: vi.fn(async (params: { operationId: string }) =>
        status("claimed", { operation_id: params.operationId, action: "reply" })),
      threadPage: vi.fn(async () => ({
        account_id: ACCOUNT,
        channel_id: "UC-x",
        binding_generation: 1,
        video_id: "vid-1",
        list: "published" as const,
        items: [ownRow(), childWithoutParent, otherThread],
        next_cursor: null,
        inconsistent_count: 0,
      })),
    });
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    await waitFor(() => expect(result.current.threads.items).toHaveLength(3));
    let firstOutcome: unknown = null;
    let guardedOutcome: unknown = null;
    let unrelatedOutcome: unknown = null;

    await act(async () => {
      const first = result.current.reply("vid-1", childWithoutParent, "reply to child");
      await waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
      expect(storedOperations()).toEqual([expect.objectContaining({
        targetCommentId: "c-child",
      })]);
      expect(storedOperations()[0]).not.toHaveProperty("targetIsCanonicalParent");

      guardedOutcome = await result.current.reply("vid-1", ownRow(), "reply to parent");
      unrelatedOutcome = await result.current.reply("vid-1", otherThread, "reply to unrelated thread");
      response.resolve(receipt());
      firstOutcome = await first;
    });

    const sent = replyMock.mock.calls[0][0] as { operationId: string };
    expect(guardedOutcome).toEqual({ kind: "pending", operationId: sent.operationId });
    expect(unrelatedOutcome).toMatchObject({ kind: "confirmed" });
    expect(firstOutcome).toMatchObject({ kind: "confirmed", operationId: sent.operationId });
    expect(replyMock).toHaveBeenCalledTimes(2);
  });
});

describe("submit cancellation during recovery", () => {
  it.each(["account-switch", "video-switch", "unmount", "rapid-round-trip"] as const)(
    "returns cancelled without a write or a new identity: %s",
    async (scenario) => {
      const recovery = deferred<Stage4OperationStatusPayload>();
      const operationStatus = vi.fn()
        .mockImplementationOnce(() => recovery.promise)
        .mockImplementation(async () => status("claimed", { operation_id: "op-earlier" }));
      const gateway = makeGateway({
        operationStatus,
        videoPage: vi.fn(async () => ({
          account_id: ACCOUNT,
          channel_id: "UC-x",
          items: [
            { id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null },
            { id: "vid-2", title: "Second upload", published_at: null, thumbnail_url: null },
          ],
          next_cursor: null,
        })),
      });
      const edit = gateway.edit as ReturnType<typeof vi.fn>;
      const view = renderHook(
        ({ accountId }) => useYouTubeStage4({ userId: USER, accountId, gateway }),
        { initialProps: { accountId: ACCOUNT }, wrapper: ({ children }) => withClient(children) },
      );
      if (scenario === "video-switch") {
        await waitFor(() => expect(view.result.current.effectiveVideoId).toBe("vid-1"));
      }
      seedEarlierOperation();
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 200_000);

      const submission = view.result.current.editComment("vid-1", ownRow(), "must not be sent");
      expect(operationStatus).toHaveBeenCalledTimes(1);
      if (scenario === "account-switch") {
        view.rerender({ accountId: OTHER_ACCOUNT });
      } else if (scenario === "video-switch") {
        act(() => {
          view.result.current.setSelectedVideoId("vid-2");
        });
      } else if (scenario === "unmount") {
        view.unmount();
      } else {
        view.rerender({ accountId: OTHER_ACCOUNT });
        view.rerender({ accountId: ACCOUNT });
      }

      let outcome: unknown = null;
      await act(async () => {
        recovery.reject(new YouTubeCommentsError("not_found"));
        outcome = await submission;
      });

      expect(outcome).toEqual({ kind: "cancelled" });
      expect(edit).not.toHaveBeenCalled();
      expect(storedOperations()).toEqual([expect.objectContaining({
        operationId: "op-earlier",
        targetCommentId: "c-mine",
      })]);
    },
  );

  it("a fresh submit after a rapid round-trip is not blocked by the cancelled recovery lock", async () => {
    const recovery = deferred<Stage4OperationStatusPayload>();
    const operationStatus = vi.fn()
      .mockImplementationOnce(() => recovery.promise)
      .mockImplementation(async () => status("claimed", { operation_id: "op-earlier" }));
    const gateway = makeGateway({ operationStatus });
    const view = renderHook(
      ({ accountId }) => useYouTubeStage4({ userId: USER, accountId, gateway }),
      { initialProps: { accountId: ACCOUNT }, wrapper: ({ children }) => withClient(children) },
    );
    seedEarlierOperation();

    const stale = view.result.current.editComment("vid-1", ownRow(), "stale");
    view.rerender({ accountId: OTHER_ACCOUNT });
    view.rerender({ accountId: ACCOUNT });

    let freshOutcome: unknown = null;
    await act(async () => {
      freshOutcome = await view.result.current.editComment("vid-1", ownRow(), "fresh");
    });
    expect(freshOutcome).toEqual({ kind: "pending", operationId: "op-earlier" });
    // Call 1: stale submit; call 2: round-trip mount recovery effect; call 3: fresh submit.
    expect(operationStatus).toHaveBeenCalledTimes(3);

    const threadPage = gateway.threadPage as ReturnType<typeof vi.fn>;
    const threadLoadsBefore = threadPage.mock.calls.length;
    let staleOutcome: unknown = null;
    await act(async () => {
      recovery.resolve(status("confirmed", { operation_id: "op-earlier" }));
      staleOutcome = await stale;
    });
    expect(staleOutcome).toEqual({ kind: "cancelled" });
    expect(threadPage.mock.calls.length).toBe(threadLoadsBefore);
  });
});

describe("Issue #485 composer cancellation and unmount during a submit", () => {
  it("Cancel releases a recovery-only lock without a write or new identity, and an immediate reopen can submit", async () => {
    const cancelledRecovery = deferred<Stage4OperationStatusPayload>();
    const operationStatus = vi.fn()
      .mockImplementationOnce(() => cancelledRecovery.promise)
      .mockRejectedValueOnce(new YouTubeCommentsError("not_found"));
    const gateway = makeGateway({ operationStatus });
    const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
    render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "cancelled reply" } });
    seedEarlierOperation("reply");
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 200_000);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(operationStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Write a reply")).not.toBeInTheDocument();
    expect(replyMock).not.toHaveBeenCalled();
    expect(storedOperations()).toEqual([expect.objectContaining({ operationId: "op-earlier" })]);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "fresh reply" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const sent = replyMock.mock.calls[0][0] as { operationId: string };
    expect(sent.operationId).not.toBe("op-earlier");
    expect(await screen.findByText("Accepted by YouTube.")).toBeInTheDocument();

    await act(async () => {
      cancelledRecovery.resolve(status("confirmed", { operation_id: "op-earlier", action: "reply" }));
      await cancelledRecovery.promise;
    });
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it("an unmounted composer leaves a confirmed write's identity stored for later recovery", async () => {
    const response = deferred<Stage4ReceiptPayload>();
    const gateway = makeGateway({ reply: vi.fn(() => response.promise) });
    const replyMock = gateway.reply as ReturnType<typeof vi.fn>;
    const view = render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "reply before unmount" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
    const sent = replyMock.mock.calls[0][0] as { operationId: string };
    expect(storedOperations()).toEqual([expect.objectContaining({ operationId: sent.operationId })]);

    view.unmount();
    await act(async () => {
      response.resolve(receipt());
      await response.promise;
    });

    expect(storedOperations()).toEqual([expect.objectContaining({
      operationId: sent.operationId,
      targetCommentId: "c-mine",
    })]);
  });
});

describe("concurrent submit operation identities", () => {
  it("a second submit during a newly minted write receives that new operation id", async () => {
    const response = deferred<Stage4ReceiptPayload>();
    const gateway = makeGateway({ edit: vi.fn(() => response.promise) });
    const edit = gateway.edit as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), {
      wrapper: ({ children }) => withClient(children),
    });
    let firstOutcome: unknown = null;
    let secondOutcome: unknown = null;

    await act(async () => {
      const first = result.current.editComment("vid-1", ownRow(), "first edit");
      const second = result.current.editComment("vid-1", ownRow(), "second edit");
      secondOutcome = await second;
      response.resolve(receipt());
      firstOutcome = await first;
    });

    const sent = edit.mock.calls[0][0] as { operationId: string };
    expect(secondOutcome).toEqual({ kind: "pending", operationId: sent.operationId });
    expect(firstOutcome).toMatchObject({ kind: "confirmed", operationId: sent.operationId });
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("the composer shows no Check status button for a concurrent submit during recovery", async () => {
    const recovery = deferred<Stage4OperationStatusPayload>();
    const gateway = makeGateway({
      operationStatus: vi.fn(() => recovery.promise),
      threadPage: vi.fn(async () => ({
        account_id: ACCOUNT,
        channel_id: "UC-x",
        binding_generation: 1,
        video_id: "vid-1",
        list: "published" as const,
        items: [ownRow(), childRow()],
        next_cursor: null,
        inconsistent_count: 0,
      })),
    });
    const reply = gateway.reply as ReturnType<typeof vi.fn>;
    render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    fireEvent.click(await screen.findByRole("button", { name: "Load replies" }));
    const replyActions = await screen.findAllByRole("button", { name: "Reply" });
    expect(replyActions).toHaveLength(2);
    fireEvent.click(replyActions[0]);
    fireEvent.click(replyActions[1]);
    const editors = screen.getAllByLabelText("Write a reply");
    fireEvent.change(editors[0], { target: { value: "parent submit" } });
    fireEvent.change(editors[1], { target: { value: "child submit" } });
    seedEarlierOperation("reply");
    const submitButtons = screen.getAllByRole("button", { name: "Reply" });

    await act(async () => {
      fireEvent.click(submitButtons[0]);
      await Promise.resolve();
      fireEvent.click(submitButtons[1]);
    });

    expect(await screen.findByText(/An earlier attempt for this comment is still being checked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
    expect(reply).not.toHaveBeenCalled();

    await act(async () => {
      recovery.resolve(status("confirmed", { operation_id: "op-earlier", action: "reply" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText(/Your earlier action was accepted by YouTube/)).toBeInTheDocument();
    expect(reply).not.toHaveBeenCalled();
  });
});
