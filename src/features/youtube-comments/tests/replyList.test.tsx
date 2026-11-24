// T6 (Stage 4 follow-up PR 2): the reply list.
//
//   B3  drafts live outside the row that shows them, so a Refresh (which returns
//       the reply chain to page one and unmounts every row of page two) does not
//       lose what the owner typed;
//   B4  "Reload from the start" reads the thread list again first, so the reply
//       request carries the NEW handle instead of the one that was refused;
//   M3  for one comment id the row of the later successful read wins.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeCommentsScreen } from "../ui/YouTubeCommentsScreen";
import type { YouTubeCommentsGateway } from "../application/ports";
import type { Stage4CapabilitiesPayload, Stage4CommentRow, Stage4ReceiptPayload } from "../domain/types";
import { YouTubeCommentsError } from "../domain/errors";
import { mergeReplyRows } from "../application/mergeReplyRows";
import { createStage4DraftStore, draftKey } from "../application/stage4Drafts";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function capabilities(): Stage4CapabilitiesPayload {
  const on = { allowed: true, reason: null };
  return { account_id: ACCOUNT, capabilities: { read: on, held: on, write: on, ban: { allowed: false, reason: "capability_off" } } };
}

function row(overrides: Partial<Stage4CommentRow>): Stage4CommentRow {
  return {
    handle: "hdl",
    kind: "thread",
    comment_id: "c",
    thread_id: "t-1",
    video_id: "vid-1",
    canonical_parent_id: "",
    author_channel_id: "UC-author",
    author_name: "Author",
    author_avatar_url: null,
    text: "text",
    published_at: "2026-01-02T00:00:00Z",
    like_count: 0,
    moderation_status: "published",
    is_own: false,
    ...overrides,
  };
}

const reply = (id: string, text: string, overrides: Partial<Stage4CommentRow> = {}) =>
  row({ kind: "reply", comment_id: id, handle: `hdl-${id}`, canonical_parent_id: "c-parent", text, ...overrides });

function receipt(): Stage4ReceiptPayload {
  return {
    operation_id: "op-1", action: "edit", state: "confirmed", reason: null, provider_class: null, moderation_status: null,
    ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: 1, channel_id: "UC-x",
  } as Stage4ReceiptPayload;
}

interface Script {
  threads?: () => Stage4CommentRow[];
  generation?: () => number;
  replyPage?: (params: { parentHandle: string; cursor?: string | null }) => Promise<{ items: Stage4CommentRow[]; next: string | null }>;
}

function makeGateway(script: Script) {
  const gateway = {
    capabilities: vi.fn(async () => capabilities()),
    videoPage: vi.fn(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x",
      items: [{ id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null }], next_cursor: null,
    })),
    threadPage: vi.fn(async () => ({
      account_id: ACCOUNT, channel_id: "UC-x", binding_generation: script.generation?.() ?? 1, video_id: "vid-1", list: "published" as const,
      items: script.threads?.() ?? [row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" })],
      next_cursor: null, inconsistent_count: 0,
    })),
    replyPage: vi.fn(async (params: { parentHandle: string; cursor?: string | null }) => {
      const page = await (script.replyPage ?? (async () => ({ items: [], next: null })))(params);
      return {
        account_id: ACCOUNT, channel_id: "UC-x", binding_generation: script.generation?.() ?? 1, parent_handle: params.parentHandle,
        items: page.items, next_cursor: page.next, inconsistent_count: 0,
      };
    }),
    createThread: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(async () => receipt()),
    banConfirmation: vi.fn(),
    deleteOwnComment: vi.fn(),
    moderate: vi.fn(),
    operationStatus: vi.fn(),
  } as unknown as YouTubeCommentsGateway;
  return gateway;
}

function renderScreen(gateway: YouTubeCommentsGateway) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <YouTubeCommentsScreen userId={USER} accountId={ACCOUNT} gateway={gateway} />
    </QueryClientProvider>,
  );
}

/** The card of one comment, found by its text. */
const cardOf = (text: string): HTMLElement => {
  // The row text comes first in the DOM; an open editor holds the same words in its textarea.
  const card = screen.getAllByText(text)[0].closest("div.p-4");
  if (!card) throw new Error(`no card for ${text}`);
  return card as HTMLElement;
};

/** Two pages of replies: page one has r1, page two has r2 (someone else's) and r3 (the channel's own). */
const twoPages = async ({ cursor }: { cursor?: string | null }) => cursor
  ? { items: [reply("c-r2", "text r2"), reply("c-r3", "text r3", { is_own: true })], next: null }
  : { items: [reply("c-r1", "text r1")], next: "cur-2" };

async function openReplyPageTwo() {
  await screen.findByText("the parent");
  fireEvent.click(screen.getAllByRole("button", { name: "Load replies" })[0]);
  await screen.findByText("text r1");
  fireEvent.click(screen.getByRole("button", { name: "More replies" }));
  await screen.findByText("text r3");
}

async function typeDrafts() {
  fireEvent.click(within(cardOf("text r2")).getByRole("button", { name: "Reply" }));
  fireEvent.change(within(cardOf("text r2")).getByLabelText("Write a reply"), { target: { value: "draft for r2" } });
  fireEvent.click(within(cardOf("text r3")).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(cardOf("text r3")).getByLabelText("Edit your comment"), { target: { value: "edited r3" } });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("T6 B3: drafts outlive the row that shows them", () => {
  it("a Refresh returns the chain to page one; 'More replies' brings the rows back with both editors open and their text", async () => {
    const gateway = makeGateway({ replyPage: twoPages });
    renderScreen(gateway);
    await openReplyPageTwo();
    await typeDrafts();
    // Nothing the owner typed reaches browser storage.
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/draft for r2|edited r3/);

    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await waitFor(() => expect(screen.queryByText("text r2")).not.toBeInTheDocument());
    // The reply block tells the owner that a draft is waiting on a row that is not loaded.
    expect(screen.getByTestId("yt-stage4-draft-waiting")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "More replies" }));
    await screen.findByText("text r3");
    expect((within(cardOf("text r2")).getByLabelText("Write a reply") as HTMLTextAreaElement).value).toBe("draft for r2");
    expect((within(cardOf("text r3")).getByLabelText("Edit your comment") as HTMLTextAreaElement).value).toBe("edited r3");
    expect(screen.queryByTestId("yt-stage4-draft-waiting")).not.toBeInTheDocument();
  });

  it("the same after a confirmed action on another thread", async () => {
    const gateway = makeGateway({
      threads: () => [
        row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" }),
        row({ comment_id: "c-other", handle: "hdl-other", text: "my other thread", is_own: true }),
      ],
      replyPage: async (params) => (params.parentHandle === "hdl-parent" ? twoPages(params) : { items: [], next: null }),
    });
    renderScreen(gateway);
    await openReplyPageTwo();
    await typeDrafts();

    // A confirmed edit of the OTHER thread reloads the list, and with it every open reply chain.
    fireEvent.click(within(cardOf("my other thread")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(cardOf("my other thread")).getByLabelText("Edit your comment"), { target: { value: "my other thread, fixed" } });
    fireEvent.click(within(cardOf("my other thread")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect((gateway.edit as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("text r2")).not.toBeInTheDocument());

    fireEvent.click(await screen.findByRole("button", { name: "More replies" }));
    await screen.findByText("text r3");
    expect((within(cardOf("text r2")).getByLabelText("Write a reply") as HTMLTextAreaElement).value).toBe("draft for r2");
    expect((within(cardOf("text r3")).getByLabelText("Edit your comment") as HTMLTextAreaElement).value).toBe("edited r3");
  });

  it("Cancel removes the draft: after a Refresh the editor stays closed", async () => {
    const gateway = makeGateway({ replyPage: twoPages });
    renderScreen(gateway);
    await openReplyPageTwo();
    fireEvent.click(within(cardOf("text r2")).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(cardOf("text r2")).getByLabelText("Write a reply"), { target: { value: "to be cancelled" } });
    fireEvent.click(within(cardOf("text r2")).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await waitFor(() => expect(screen.queryByText("text r2")).not.toBeInTheDocument());
    expect(screen.queryByTestId("yt-stage4-draft-waiting")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "More replies" }));
    await screen.findByText("text r2");
    expect(within(cardOf("text r2")).queryByLabelText("Write a reply")).not.toBeInTheDocument();
  });

  it("a change of the binding generation drops the drafts: the old binding's text is not offered again", async () => {
    let generation = 1;
    const gateway = makeGateway({ generation: () => generation, replyPage: twoPages });
    renderScreen(gateway);
    await openReplyPageTwo();
    fireEvent.click(within(cardOf("text r2")).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(cardOf("text r2")).getByLabelText("Write a reply"), { target: { value: "written under generation 1" } });

    generation = 2; // the channel was reconnected
    fireEvent.click(screen.getByRole("button", { name: "Refresh comments" }));
    await waitFor(() => expect(screen.queryByText("text r2")).not.toBeInTheDocument());
    await screen.findByText("text r1");
    expect(screen.queryByTestId("yt-stage4-draft-waiting")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "More replies" }));
    await screen.findByText("text r2");
    expect(within(cardOf("text r2")).queryByLabelText("Write a reply")).not.toBeInTheDocument();
  });
});

describe("T6 B4: reload from the start reads the thread list first", () => {
  it("the reply request carries the NEW handle and the refused one is never sent again", async () => {
    let loads = 0;
    const gateway = makeGateway({
      threads: () => {
        loads += 1;
        return [row({ comment_id: "c-parent", handle: `hdl-parent-load-${loads}`, text: "the parent" })];
      },
      replyPage: async ({ parentHandle, cursor }) => {
        if (parentHandle === "hdl-parent-load-1" && cursor) throw new YouTubeCommentsError("expired_handle");
        if (parentHandle === "hdl-parent-load-1") return { items: [reply("c-r1", "text r1")], next: "cur-2" };
        return { items: [reply("c-r1", "text r1 reloaded")], next: null };
      },
    });
    renderScreen(gateway);
    await screen.findByText("the parent");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await screen.findByText("text r1");
    fireEvent.click(screen.getByRole("button", { name: "More replies" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload from the start" }));

    await screen.findByText("text r1 reloaded");
    const threadPage = gateway.threadPage as ReturnType<typeof vi.fn>;
    const replyPage = gateway.replyPage as ReturnType<typeof vi.fn>;
    expect(threadPage.mock.calls.length).toBe(2);
    const handles = replyPage.mock.calls.map((call) => (call[0] as { parentHandle: string }).parentHandle);
    // page one, the refused page two, then the reload: nothing sent with the old handle after the refusal.
    expect(handles).toEqual(["hdl-parent-load-1", "hdl-parent-load-1", "hdl-parent-load-2"]);
  });
});

describe("T6 M3: the row from the later successful read wins", () => {
  it("a reply page read AFTER the thread page shows the newer text, status and handle", async () => {
    const gateway = makeGateway({
      threads: () => [row({ comment_id: "c-parent", handle: "hdl-parent", text: "the parent" }), reply("c-r1", "inline OLD", { handle: "hdl-old", moderation_status: "published" })],
      replyPage: async () => ({ items: [reply("c-r1", "reply page NEWER", { handle: "hdl-newer", moderation_status: "heldForReview" })], next: null }),
    });
    renderScreen(gateway);
    await screen.findByText("the parent");
    fireEvent.click(screen.getByRole("button", { name: "Load replies" }));
    await screen.findByText("reply page NEWER");
    expect(screen.queryByText("inline OLD")).not.toBeInTheDocument();
    expect(within(cardOf("reply page NEWER")).getByText("Held for review")).toBeInTheDocument();
  });
});

describe("T6 mergeReplyRows", () => {
  const r = (id: string, text: string, handle = "h") => reply(id, text, { handle });
  const at = (readAt: number, ...rows: Stage4CommentRow[]) => rows.map((row) => ({ row, readAt }));

  it.each([
    { name: "the inline row when it was read later", inlineAt: 20, pagedAt: 10, expected: "inline" },
    { name: "the paged row when it was read later", inlineAt: 10, pagedAt: 20, expected: "paged" },
    { name: "the paged row on a tie", inlineAt: 10, pagedAt: 10, expected: "paged" },
  ])("takes $name", ({ inlineAt, pagedAt, expected }) => {
    const merged = mergeReplyRows(at(inlineAt, r("a", "inline")), at(pagedAt, r("a", "paged")));
    expect(merged.map((x) => x.text)).toEqual([expected]);
  });

  it("keeps the rows that exist on one side only, paged order first", () => {
    const merged = mergeReplyRows(at(5, r("b", "only inline")), at(5, r("a", "only paged"), r("c", "also paged")));
    expect(merged.map((x) => x.comment_id)).toEqual(["a", "c", "b"]);
  });

  it("takes text, moderation status and handle from the newer read together", () => {
    const merged = mergeReplyRows(
      at(30, { ...r("a", "newer", "h-new"), moderation_status: "heldForReview" }),
      at(10, { ...r("a", "older", "h-old"), moderation_status: "published" }),
    );
    expect(merged[0]).toMatchObject({ text: "newer", handle: "h-new", moderation_status: "heldForReview" });
  });
});

describe("T6 the draft store", () => {
  it("keys by account, binding generation, comment id and kind; forgets other generations", () => {
    const store = createStage4DraftStore();
    const reply1 = draftKey(ACCOUNT, 1, "c-r2", "reply");
    store.set(reply1, { text: "kept", open: true, parentCommentId: "c-parent" });
    store.set(draftKey(ACCOUNT, 1, "c-r2", "edit"), { text: "edit", open: true, parentCommentId: "c-parent" });
    expect(store.get(reply1)?.text).toBe("kept");
    expect(store.get(draftKey(ACCOUNT, 2, "c-r2", "reply"))).toBeUndefined();
    expect(store.forParent("c-parent")).toHaveLength(2);
    store.keepGeneration(2);
    expect(store.get(reply1)).toBeUndefined();
    expect(store.forParent("c-parent")).toHaveLength(0);
  });

  it("notifies subscribers of a change and of a removal", () => {
    const store = createStage4DraftStore();
    const seen = vi.fn();
    const stop = store.subscribe(seen);
    const key = draftKey(ACCOUNT, 1, "c-r2", "reply");
    store.set(key, { text: "a", open: true, parentCommentId: "p" });
    store.remove(key);
    stop();
    store.set(key, { text: "b", open: true, parentCommentId: "p" });
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
