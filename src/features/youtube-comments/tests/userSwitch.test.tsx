import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useYouTubeStage4 } from "../application/useYouTubeStage4";
import type { YouTubeCommentsGateway } from "../application/ports";
import type { Stage4CapabilitiesPayload, Stage4CommentRow } from "../domain/types";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

const capabilities: Stage4CapabilitiesPayload = {
  account_id: ACCOUNT,
  capabilities: {
    read: { allowed: true, reason: null },
    held: { allowed: true, reason: null },
    write: { allowed: true, reason: null },
    ban: { allowed: false, reason: "capability_off" },
  },
};

function commentRow(id: string): Stage4CommentRow {
  return {
    handle: `hdl-${id}`,
    kind: "thread",
    comment_id: id,
    thread_id: `t-${id}`,
    video_id: "vid-1",
    canonical_parent_id: "",
    author_channel_id: "UC-author",
    author_name: "Author",
    author_avatar_url: null,
    text: id,
    published_at: "2026-01-02T00:00:00Z",
    like_count: 0,
    moderation_status: "published",
    is_own: false,
  };
}

beforeEach(() => localStorage.clear());

describe("a paged list on a hook that stays mounted across a user switch", () => {
  it("starts a new cursor chain for the new user and shows none of the previous user's pages", async () => {
    let who = "A";
    const requested: Array<{ who: string; cursor: string | undefined }> = [];
    const videosRequested: Array<{ who: string; cursor: string | undefined }> = [];
    const gateway = {
      capabilities: async () => capabilities,
      videoPage: async (_accountId: string, cursor?: string | null) => {
        const first = !cursor;
        videosRequested.push({ who, cursor: cursor ?? undefined });
        return {
          account_id: ACCOUNT,
          channel_id: "UC-x",
          items: first
            ? [{ id: "vid-1", title: "First upload", published_at: null, thumbnail_url: null }]
            : [{ id: `vid-${who}-more`, title: "Older upload", published_at: null, thumbnail_url: null }],
          next_cursor: first ? `vcursor-of-${who}` : null,
        };
      },
      threadPage: async (params: { cursor?: string | null }) => {
        const first = !params.cursor;
        requested.push({ who, cursor: params.cursor ?? undefined });
        return {
          account_id: ACCOUNT,
          channel_id: "UC-x",
          video_id: "vid-1",
          list: "published" as const,
          items: [commentRow(`${who}-${first ? "p1" : "p2"}`)],
          next_cursor: first ? `cursor-of-${who}` : null,
          inconsistent_count: 0,
        };
      },
      replyPage: async () => ({ account_id: ACCOUNT, channel_id: "UC-x", parent_handle: "h", items: [], next_cursor: null, inconsistent_count: 0 }),
      operationStatus: async () => { throw new Error("not used"); },
    } as unknown as YouTubeCommentsGateway;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(
      (props: { userId: string }) => useYouTubeStage4({ userId: props.userId, accountId: ACCOUNT, gateway }),
      { wrapper, initialProps: { userId: USER_A } },
    );

    await waitFor(() => expect(result.current.threads.items.map((item) => item.key)).toEqual(["A-p1"]));
    act(() => result.current.threads.loadMore());
    await waitFor(() => expect(result.current.threads.items.map((item) => item.key)).toEqual(["A-p1", "A-p2"]));

    // The uploads list has a second page too: its cursor is signed for user A.
    act(() => result.current.videos.loadMore());
    await waitFor(() => expect(result.current.videos.items.map((item) => item.id)).toEqual(["vid-1", "vid-A-more"]));

    who = "B";
    rerender({ userId: USER_B });
    await waitFor(() => expect(result.current.threads.items.map((item) => item.key)).toEqual(["B-p1"]));
    await waitFor(() => expect(result.current.videos.items.map((item) => item.id)).toEqual(["vid-1"]));

    const forB = requested.filter((request) => request.who === "B");
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((request) => request.cursor === undefined)).toBe(true);
    expect(result.current.threads.items.some((item) => item.key.startsWith("A-"))).toBe(false);
    const videosForB = videosRequested.filter((request) => request.who === "B");
    expect(videosForB.length).toBeGreaterThan(0);
    expect(videosForB.every((request) => request.cursor === undefined), "the new user never sends the previous user's cursor").toBe(true);
    expect(result.current.videos.items.some((item) => item.id.includes("-A-"))).toBe(false);
  });
});
