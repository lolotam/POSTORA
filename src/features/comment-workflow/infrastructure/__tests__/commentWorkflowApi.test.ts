import { describe, expect, it, vi } from "vitest";

const from = vi.fn();
const invoke = vi.fn();
const getUser = vi.fn(async () => ({ data: { user: { id: "user-1" } } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
    functions: { invoke: (name: string, options: unknown) => invoke(name, options) },
    auth: { getUser: () => getUser() },
  },
}));

import { createRule, fetchAttachableMedia, fetchRecentPosts, fetchRules } from "../commentWorkflowApi";

/** Records the filters a query applied, so a dropped `.eq` or `.like` is visible. */
function queryStub(result: { data?: unknown; error?: unknown }) {
  const filters: Array<[string, string]> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: string) => {
      filters.push(["eq", `${column}=${value}`]);
      return builder;
    },
    like: (column: string, value: string) => {
      filters.push(["like", `${column}=${value}`]);
      return builder;
    },
    limit: () => Promise.resolve(result),
    order: () => builder,
    then: (resolve: (value: unknown) => unknown) => resolve(result),
  };
  return { builder, filters };
}

describe("fetchAttachableMedia", () => {
  it("offers only files in the signable bucket, under the caller's own path prefix", async () => {
    // Both filters are load-bearing. `media` is the only bucket signMediaPath signs, and the
    // path prefix is what the send path enforces through ownedStoragePath — media_files' insert
    // policy constrains the row's owner but not its file_path, so a row can name an object its
    // owner does not have. Offering such a row here produces a workflow that silently ships
    // without its link.
    const query = queryStub({
      data: [{ id: "m1", file_path: "user-1/guide.pdf", file_type: "document", file_size: 10 }],
      error: null,
    });
    from.mockReturnValue(query.builder);

    const media = await fetchAttachableMedia();

    expect(from).toHaveBeenCalledWith("media_files");
    expect(query.filters).toContainEqual(["eq", "storage_bucket=media"]);
    expect(query.filters).toContainEqual(["like", "file_path=user-1/%"]);
    expect(media).toEqual([{ id: "m1", label: "guide.pdf · document" }]);
  });

  it("raises when the read fails, so a failure cannot read as an empty library", async () => {
    from.mockReturnValue(queryStub({ data: null, error: { message: "statement timeout" } }).builder);
    await expect(fetchAttachableMedia()).rejects.toBeTruthy();
  });
});

describe("fetchRules", () => {
  it("raises rather than returning an empty list when the read fails", async () => {
    // An empty list and a failed read are the same picture on screen, and only one is true.
    from.mockReturnValue(queryStub({ data: null, error: { message: "connection reset" } }).builder);
    await expect(fetchRules()).rejects.toBeTruthy();
  });
});

describe("createRule", () => {
  it("stamps the row with the signed-in user, never a caller-supplied id", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    from.mockReturnValue({ insert });

    await createRule({
      social_account_id: "acct-1",
      platform: "instagram",
      name: "Guide",
      target_post_id: null,
      match_type: "any",
      keywords: [],
      public_replies: ["hi"],
      dm_message: null,
      media_file_id: null,
      send_once_per_user: true,
      is_active: true,
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user-1", name: "Guide" }));
  });
});

describe("fetchRecentPosts", () => {
  it("asks the comment manager with the action each platform needs", async () => {
    invoke.mockResolvedValue({ data: { data: [{ id: "p1", message: "Launch day" }] }, error: null });

    const facebook = await fetchRecentPosts("facebook", "acct-1", "page-1");
    expect(invoke).toHaveBeenCalledWith("comment-manager", {
      body: { action: "get_page_comments", social_account_id: "acct-1", page_id: "page-1" },
    });
    expect(facebook).toEqual([{ id: "p1", label: "Launch day" }]);

    await fetchRecentPosts("instagram", "acct-2", "ig-1");
    expect(invoke).toHaveBeenCalledWith("comment-manager", {
      body: { action: "get_ig_comments", social_account_id: "acct-2", ig_user_id: "ig-1" },
    });
  });

  it("lists a YouTube channel's videos through the comment manager, titled or by id", async () => {
    // YouTube has no comment-bearing post feed to reuse; the channel's uploads are the scope
    // list, and `target_post_id` stores the video id.
    invoke.mockClear();
    invoke.mockResolvedValue({ data: { videos: [{ id: "v1", title: "Launch" }, { id: "abcdef123456", title: "" }] }, error: null });

    const videos = await fetchRecentPosts("youtube", "acc", "UC1");

    expect(invoke).toHaveBeenCalledWith("comment-manager", {
      body: { action: "get_youtube_videos", social_account_id: "acc" },
    });
    expect(videos).toEqual([{ id: "v1", label: "Launch" }, { id: "abcdef123456", label: "Video 123456" }]);
  });

  it("surfaces the YouTube action's plain-string error, which is the reason the user needs", async () => {
    // get_youtube_videos fails as { error_type, error: "<sentence>" }; reading it through Meta's
    // nested shape would turn "Reconnect the channel" into a canned line.
    invoke.mockClear();
    invoke.mockResolvedValue({ data: { error_type: "MISSING_SCOPE", error: "Reconnect the channel in Profiles." }, error: null });
    await expect(fetchRecentPosts("youtube", "acc", "UC1")).rejects.toThrow("Reconnect the channel in Profiles.");
  });

  it("returns nothing for Threads, which has no post listing here", async () => {
    invoke.mockClear();
    expect(await fetchRecentPosts("threads", "acct-3", "th-1")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("raises on a platform error carried inside a successful response", async () => {
    // The comment manager forwards Meta's own shape, so an error can arrive with no transport
    // failure at all. Treating that as an empty post list would hide an expired token.
    invoke.mockResolvedValue({ data: { error: { message: "Session expired" } }, error: null });
    await expect(fetchRecentPosts("facebook", "acct-1", "page-1")).rejects.toThrow("Session expired");
  });

  it("labels a post with no caption by its id rather than showing a blank row", async () => {
    invoke.mockResolvedValue({ data: { data: [{ id: "1784412345678" }] }, error: null });
    const posts = await fetchRecentPosts("facebook", "acct-1", "page-1");
    expect(posts).toEqual([{ id: "1784412345678", label: "Post 12345678" }]);
  });
});
