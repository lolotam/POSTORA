import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { usePostRetry } from "../usePostRetry";

interface MediaPayload { file_path: string; file_size: number }

/**
 * One Supabase client mock for the whole file. The retry request leaves through
 * `functions.invoke`, so the real `enqueuePostPublish` module keeps building the
 * wire body and every assertion below stays on that boundary. The client mock
 * is table aware: `media_files` answers the upload flow, every other table is a
 * mistake the retry path must never make.
 */
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  from: vi.fn(),
  toast: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  insertRow: vi.fn(),
  deleteRows: vi.fn(),
  reconcileRow: vi.fn(),
  sequence: 0,
  mediaRows: 0,
  failInsertSize: -1,
  insertedPaths: [] as string[],
  log: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mock.from,
    rpc: async () => ({ data: ++mock.sequence, error: null }),
    functions: { invoke: mock.invoke },
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: { from: () => ({ upload: mock.upload, remove: mock.remove }) },
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mock.toast }) }));

const { invoke, from, toast, upload, remove, insertRow, deleteRows, reconcileRow } = mock;

const post = { id: "post-1", platformResults: [
  { id: "failed-1", platform: "facebook", status: "failed", social_account_id: "account-1" },
  { id: "success-1", platform: "facebook", status: "success", social_account_id: "account-2" },
] };

const goodFile = () => new File(["x".repeat(10)], "good.jpg", { type: "image/jpeg" });
const badFile = () => new File(["y".repeat(20)], "bad.jpg", { type: "image/jpeg" });

function renderRetry() {
  const client = new QueryClient();
  return renderHook(() => usePostRetry(), { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) });
}

function openMediaRetry(result: { current: ReturnType<typeof usePostRetry> }, files: File[]) {
  act(() => {
    result.current.openRetryMediaDialog({ id: post.id });
    result.current.setRetryMediaFiles(files);
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mock.sequence = 0;
  mock.mediaRows = 0;
  mock.failInsertSize = -1;
  mock.insertedPaths = [];
  mock.log = [];
  invoke.mockResolvedValue({ data: { accepted: true, post_id: "post-1", status: "processing" }, error: null });
  from.mockImplementation((table: string) => {
    if (table !== "media_files") throw new Error(`Unexpected table: ${table}`);
    const reconcileQuery = {
      eq: () => reconcileQuery,
      maybeSingle: () => reconcileRow(),
    };
    return {
      insert: (payload: MediaPayload) => ({ select: () => ({ single: () => insertRow(payload) }) }),
      delete: () => ({ in: (_column: string, ids: string[]) => deleteRows(ids) }),
      select: (_columns: string) => reconcileQuery,
    };
  });
  upload.mockImplementation(async (path: string) => {
    mock.log.push("upload");
    return { data: { path }, error: null };
  });
  remove.mockImplementation(async () => {
    mock.log.push("remove");
    return { error: null };
  });
  insertRow.mockImplementation(async (payload: MediaPayload) => {
    mock.log.push("insert");
    if (payload.file_size === mock.failInsertSize) return { data: null, error: { message: "database unavailable" } };
    mock.mediaRows += 1;
    mock.insertedPaths.push(payload.file_path);
    return { data: { id: `media-${mock.mediaRows}`, file_path: payload.file_path }, error: null };
  });
  deleteRows.mockImplementation(async () => {
    mock.log.push("delete");
    return { error: null };
  });
  reconcileRow.mockImplementation(async () => {
    mock.log.push("reconcile");
    return { data: null, error: null };
  });
  toast.mockImplementation(() => { mock.log.push("toast"); });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("post retry submission", () => {
  it("routes a managed Story result to Story-only retry", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { response_data: { story_job_id: "story-job" } }, error: null })) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); from.mockReturnValue(query);
    const { result } = renderRetry();
    await act(async () => { await result.current.handleRetrySinglePlatform(post.id, "story-result", "instagram", "account-1"); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("enqueue-post-publish", { body: { post_id: post.id, mode: "retry_story", result_id: "story-result" } });
  });

  it.each(["single", "failed", "bulk"] as const)("submits %s retry without deleting result rows", async (kind) => {
    const { result } = renderRetry();
    await act(async () => {
      if (kind === "single") await result.current.handleRetrySinglePlatform(post.id, "failed-1", "facebook", "account-1");
      if (kind === "failed") await result.current.handleRetryFailed(post);
      if (kind === "bulk") await result.current.handleBulkRetry([post]);
    });
    expect(from).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", { body: kind !== "bulk"
      ? { post_id: post.id, mode: "retry", account_ids: ["account-1"] }
      : { post_id: post.id, mode: "retry" } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: kind === "bulk" ? "Retry requests submitted" : "Retry submitted" }));
  });

  it("keeps a refused retry visibly failed", async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({ error: "not_retryable" }, { status: 409 })) });
    const { result } = renderRetry();
    await act(async () => { await result.current.handleRetryFailed(post); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry failed", variant: "destructive" }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Retry submitted" }));
    expect(from).not.toHaveBeenCalled();
  });

  it("does not offer a result whose outcome is unknown, because a retry could publish twice", async () => {
    const uncertain = { id: "post-2", platformResults: [
      { id: "failed-2", platform: "tiktok", status: "failed", social_account_id: "account-9", response_data: { publish_outcome: "uncertain" } },
    ] };
    const { result } = renderRetry();
    await act(async () => { await result.current.handleRetryFailed(uncertain); });
    expect(result.current.retryDialogPost).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "This result cannot be retried", variant: "destructive" }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Retry submitted" }));
  });

  it("says what to do when the database refuses every target", async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({ error: "no_targets" }, { status: 409 })) });
    const { result } = renderRetry();
    await act(async () => { await result.current.handleRetryFailed(post); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Retry failed",
      description: expect.stringContaining("Refresh History"),
    }));
  });

  it("passes only the picker selection to the retry request", async () => {
    const { result } = renderRetry();
    await act(async () => { await result.current.handleRetryFailed({ ...post, platformResults: [{ ...post.platformResults[0], platform: "tiktok" }] }); });
    act(() => result.current.toggleRetryAccountSelection("account-3"));
    const update = vi.fn(() => ({ eq: async () => ({ error: null }) }));
    from.mockReturnValue({ update });
    await act(async () => { await result.current.handleRetryWithAccounts(); });
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", { body: { post_id: post.id, mode: "retry", account_ids: ["account-1", "account-3"] } });
    expect(from).not.toHaveBeenCalledWith("platform_posts");
    expect(result.current.retryDialogPost).toBeNull();
  });

  it("limits a retry without confirmation to the accounts shown as failed", async () => {
    const { result } = renderRetry();
    const snapshot = { ...post, platformResults: [
      ...post.platformResults,
      { id: "pending-tt", platform: "tiktok", status: "pending", social_account_id: "account-2" },
    ] };
    await act(async () => { await result.current.handleRetryFailed(snapshot); });
    expect(result.current.retryDialogPost).toBeNull();
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", {
      body: { post_id: post.id, mode: "retry", account_ids: ["account-1"] },
    });
  });

  it("submits replacement media through the enqueue boundary without writing the post directly", async () => {
    const { result } = renderRetry();
    openMediaRetry(result, [new File(["image"], "photo.jpg", { type: "image/jpeg" })]);
    invoke.mockResolvedValueOnce({ data: null, error: new FunctionsHttpError(Response.json({ error: "no_targets" }, { status: 409 })) });
    await act(async () => { await result.current.handleRetryWithNewMedia(); });
    expect(result.current.retryMediaDialogPost?.id).toBe(post.id);
    await act(async () => { await result.current.handleRetryWithNewMedia(); });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalledWith("posts");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, "enqueue-post-publish", { body: { post_id: post.id, mode: "retry", replacement_media_ids: ["media-1"] } });
    expect(from).not.toHaveBeenCalledWith("platform_posts");
    expect(result.current.retryMediaDialogPost).toBeNull();
  });
});

describe("retry with new media", () => {
  it("removes the uploaded object when the media row cannot be written", async () => {
    mock.failInsertSize = 10;
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    expect(remove).toHaveBeenCalledWith([mock.insertedPaths[0] ?? upload.mock.calls[0][0]]);
    // The ambiguous insert is reconciled before the cleanup, and the removal
    // happens before the failure is reported.
    expect(mock.log).toEqual(["upload", "insert", "reconcile", "remove", "toast"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry failed" }));
  });

  it("keeps the upload when the insert committed but its answer was lost", async () => {
    mock.failInsertSize = 10;
    reconcileRow.mockImplementation(async () => {
      mock.log.push("reconcile");
      return { data: { id: "media-committed", file_path: "user-1/committed.jpg" }, error: null };
    });
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    // The committed row is kept and the object is not deleted: the retry
    // names the row the insert actually wrote.
    expect(remove).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", {
      body: { post_id: post.id, mode: "retry", replacement_media_ids: ["media-committed"] },
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry submitted" }));
  });

  it("keeps the object when the ambiguous insert cannot be reconciled", async () => {
    mock.failInsertSize = 10;
    reconcileRow.mockImplementation(async () => {
      mock.log.push("reconcile");
      return { data: null, error: { message: "database unavailable" } };
    });
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    // The insert is ambiguous and the row cannot be read: the object stays,
    // because deleting a committed object breaks the library row that names it.
    expect(remove).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry failed" }));
  });

  it("removes the sibling objects and deletes only the rows it confirmed", async () => {
    mock.failInsertSize = 20;
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile(), badFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    expect(remove).toHaveBeenCalledWith([mock.insertedPaths[0]]);
    expect(deleteRows).toHaveBeenCalledWith(["media-1"]);
    // The library row is deleted only after the object it names is gone.
    expect(mock.log.indexOf("delete")).toBeGreaterThan(mock.log.lastIndexOf("remove"));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the row and reports the leftover when the storage removal fails", async () => {
    mock.failInsertSize = 20;
    remove.mockImplementation(async () => {
      mock.log.push("remove");
      return { error: { message: "storage unavailable" } };
    });
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile(), badFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    expect(deleteRows).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("media-1"));
  });

  it("uploads fresh media after the server refuses the replacement media", async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({ error: "invalid_media" }, { status: 409 })) });
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });
    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, "enqueue-post-publish", { body: { post_id: post.id, mode: "retry", replacement_media_ids: ["media-2"] } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry failed" }));
  });

  it("submits the uploaded ids and resets the retry media afterwards", async () => {
    const { result } = renderRetry();
    openMediaRetry(result, [goodFile()]);

    await act(async () => { await result.current.handleRetryWithNewMedia(); });

    expect(invoke).toHaveBeenCalledExactlyOnceWith("enqueue-post-publish", { body: { post_id: post.id, mode: "retry", replacement_media_ids: ["media-1"] } });
    expect(remove).not.toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
    expect(result.current.retryMediaDialogPost).toBeNull();
    expect(result.current.retryMediaFiles).toEqual([]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Retry submitted" }));
  });
});
