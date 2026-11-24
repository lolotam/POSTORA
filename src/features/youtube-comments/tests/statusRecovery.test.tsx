// T5 (Stage 4 follow-up PR 2): the status check and the recovery in the browser.
//
//   M1  a submission's identity is kept in memory, so a status check works with
//       storage unavailable and never invents an action or a timestamp;
//   M2  a status check that learns the receipt is gone for good acknowledges
//       its identity once it showed that, and a pre-claim miss never does;
//   C1  a re-check that resolves before the next render cannot clear the
//       identity of a banner the owner just dismissed (both hooks);
//   O6  the standalone recovery surface is keyed by user and account;
//   O7  discarding an account's context forgets its in-memory identities.

import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeCommentsScreen, Stage4RecoveredOperations } from "../ui/YouTubeCommentsScreen";
import { useYouTubeStage4 } from "../application/useYouTubeStage4";
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
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const STORE_KEY = `postora:yt-stage4:ops:${USER}`;

const storedOps = () => JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Array<{ operationId: string; action: string; accountId: string }>;

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
    action: "create_thread",
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
  return { ...status("confirmed"), result_thread_id: "t-new", result_comment_id: "c-new" } as Stage4ReceiptPayload;
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

const operationStatusMock = (gateway: YouTubeCommentsGateway) => gateway.operationStatus as ReturnType<typeof vi.fn>;

/** An edit whose answer is lost, from a screen with the own comment on it. */
async function lostEdit(gateway: YouTubeCommentsGateway) {
  (gateway.edit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Failed to fetch"));
  render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit your comment"), { target: { value: "my edited comment" } });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T5 M1: the identity of a live submission survives a storage that does not work", () => {
  it("a status check sends the draft of an edit and keeps Check status inside the pre-claim grace", async () => {
    const gateway = makeGateway();
    await lostEdit(gateway);
    // From here on storage throws on every access, like a locked-down browser profile.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));

    operationStatusMock(gateway).mockRejectedValueOnce(new YouTubeCommentsError("not_found"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });

    const sent = operationStatusMock(gateway).mock.calls.at(-1)?.[0] as { text?: string };
    expect(sent.text).toBe("my edited comment");
    // A miss this soon after the submit is not proof of a rebind: the answer is still "lost" with its button.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    expect(screen.getByRole("alert")).not.toHaveTextContent(/reconnected/);
    expect(screen.getByRole("button", { name: "Check status" })).toBeInTheDocument();
  });

  it("an identity nobody knows is read with no draft, and a miss stays temporary: nothing is invented", async () => {
    const gateway = makeGateway();
    const wrapper = ({ children }: { children: ReactNode }) => withClient(children);
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), { wrapper });
    operationStatusMock(gateway).mockRejectedValueOnce(new YouTubeCommentsError("not_found"));
    let outcome: Awaited<ReturnType<typeof result.current.checkStatus>> | undefined;
    await act(async () => { outcome = await result.current.checkStatus("op-unknown", "a draft nobody can attribute"); });
    const sent = operationStatusMock(gateway).mock.calls.at(-1)?.[0] as { text?: string };
    expect(sent.text).toBeUndefined();
    expect(outcome).toMatchObject({ kind: "error", reason: "upstream", operationId: "op-unknown" });
    expect((outcome as { terminal?: boolean }).terminal).toBeUndefined();
  });
});

describe("T5 M2: a terminal missing receipt is acknowledged once it was shown", () => {
  it("shows the reconnect text, keeps the draft and forgets the identity", async () => {
    const gateway = makeGateway();
    await lostEdit(gateway);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    expect(storedOps()).toHaveLength(1);
    // The submit is old enough that a missing receipt is final (the pre-claim grace is over).
    const submittedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(submittedAt + 200_000);

    operationStatusMock(gateway).mockRejectedValueOnce(new YouTubeCommentsError("not_found"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/can no longer be checked here/));
    expect((screen.getByLabelText("Edit your comment") as HTMLTextAreaElement).value).toBe("my edited comment");
    expect(storedOps()).toHaveLength(0);
  });

  it("a miss inside the grace window is never acknowledged", async () => {
    const gateway = makeGateway();
    await lostEdit(gateway);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    operationStatusMock(gateway).mockRejectedValueOnce(new YouTubeCommentsError("not_found"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check status" })); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not get YouTube's answer/));
    expect(storedOps()).toHaveLength(1);
  });
});

describe("T5 C1: a re-check that resolves before the next render", () => {
  const seed = () => localStorage.setItem(STORE_KEY, JSON.stringify([{
    operationId: "op-flight", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
  }]));

  async function dismissWhileRecheckResolves(banner: HTMLElement, gateway: YouTubeCommentsGateway) {
    let release: (value: Stage4OperationStatusPayload) => void = () => undefined;
    operationStatusMock(gateway).mockImplementationOnce(() => new Promise<Stage4OperationStatusPayload>((resolve) => { release = resolve; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(operationStatusMock(gateway).mock.calls.length).toBeGreaterThanOrEqual(2));
    // Dismiss and resolve inside ONE act scope: React renders only when the scope ends, so the
    // continuation of the re-check runs before the render that would show the dismissal.
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
      release(status("confirmed", { operation_id: "op-flight" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("the admitted screen's banner keeps the identity of a banner dismissed in the same tick", async () => {
    seed();
    const gateway = makeGateway({ operationStatus: vi.fn(async () => status("dispatched", { operation_id: "op-flight" })) as never });
    render(withClient(<YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />));
    const banner = await screen.findByTestId("yt-stage4-recovered");
    await dismissWhileRecheckResolves(banner, gateway);
    expect(storedOps()).toHaveLength(1);
  });

  it("the standalone recovery banner keeps the identity of a banner dismissed in the same tick", async () => {
    seed();
    const gateway = makeGateway({ operationStatus: vi.fn(async () => status("dispatched", { operation_id: "op-flight" })) as never });
    render(<Stage4RecoveredOperations userId={USER} accountId={ACCOUNT} gateway={gateway} />);
    const banner = await screen.findByTestId("yt-stage4-recovered-standalone");
    await dismissWhileRecheckResolves(banner, gateway);
    expect(storedOps()).toHaveLength(1);
  });
});

describe("T5 O6: the standalone recovery surface follows the account", () => {
  // The panel mounts the surface keyed by user and account, like the screen. (Keying cannot close
  // a window in which the answer lands in the very tick of the switch: nothing can know the new
  // props before React renders them. It makes the surface start from nothing for each account,
  // and this guard proves that a re-check that lands AFTER the switch clears nothing.)
  it("a re-check that resolves after an account switch clears nothing the new view showed", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify([{
      operationId: "op-flight", accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
    }]));
    const gateway = makeGateway({ operationStatus: vi.fn(async () => status("dispatched", { operation_id: "op-flight" })) as never });
    const Mounted = ({ accountId }: { accountId: string }) => (
      <Stage4RecoveredOperations key={`${USER}:${accountId}`} userId={USER} accountId={accountId} gateway={gateway} />
    );
    const view = render(<Mounted accountId={ACCOUNT} />);
    const banner = await screen.findByTestId("yt-stage4-recovered-standalone");
    let release: (value: Stage4OperationStatusPayload) => void = () => undefined;
    operationStatusMock(gateway).mockImplementationOnce(() => new Promise<Stage4OperationStatusPayload>((resolve) => { release = resolve; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(operationStatusMock(gateway).mock.calls.length).toBeGreaterThanOrEqual(2));
    view.rerender(<Mounted accountId={OTHER_ACCOUNT} />);
    await act(async () => {
      release(status("confirmed", { operation_id: "op-flight" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(storedOps()).toHaveLength(1);
  });
});

describe("T5 O7: discarding an account forgets its in-memory identities", () => {
  it("after a discard a status check no longer knows the operation's action", async () => {
    const gateway = makeGateway({ edit: vi.fn(async () => { throw new Error("Failed to fetch"); }) as never });
    const wrapper = ({ children }: { children: ReactNode }) => withClient(children);
    const { result } = renderHook(() => useYouTubeStage4({ userId: USER, accountId: ACCOUNT, gateway }), { wrapper });
    // Storage cannot hold the identity: only the live map does.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage denied"); });
    let operationId = "";
    await act(async () => {
      const outcome = await result.current.editComment("vid-1", ownRow(), "my edited comment");
      if (outcome.kind !== "error") throw new Error(`Expected a lost-response error, got ${outcome.kind}`);
      operationId = outcome.operationId;
    });
    await act(async () => { await result.current.checkStatus(operationId, "my edited comment"); });
    expect((operationStatusMock(gateway).mock.calls.at(-1)?.[0] as { text?: string }).text).toBe("my edited comment");

    act(() => result.current.discardAccountContext());
    await act(async () => { await result.current.checkStatus(operationId, "my edited comment"); });
    expect((operationStatusMock(gateway).mock.calls.at(-1)?.[0] as { text?: string }).text).toBeUndefined();
  });
});
