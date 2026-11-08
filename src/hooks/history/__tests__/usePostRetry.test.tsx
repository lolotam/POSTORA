import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { usePostRetry } from "../usePostRetry";

const { invoke, from, toast, upload } = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), toast: vi.fn(), upload: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from, rpc: async () => ({ data: 1, error: null }), functions: { invoke }, auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  storage: { from: () => ({ upload }) },
} }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const post = { id: "post-1", platformResults: [
  { id: "failed-1", platform: "facebook", status: "failed", social_account_id: "account-1" },
  { id: "success-1", platform: "facebook", status: "success", social_account_id: "account-2" },
] };

function renderRetry() {
  const client = new QueryClient();
  return renderHook(() => usePostRetry(), { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) });
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue({ data: { accepted: true, post_id: "post-1", status: "processing" }, error: null });
  from.mockImplementation(() => { throw new Error("Unexpected client database mutation"); });
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
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", { body: kind === "single"
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

  it("replaces media without changing the retryable status or deleting platform results", async () => {
    const update = vi.fn(() => ({ eq: async () => ({ error: null }) }));
    from.mockImplementation((table) => {
      if (table === "posts") return { update };
      if (table === "media_files") return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: "media-1" }, error: null }) }) }) };
      throw new Error(`Unexpected table: ${table}`);
    });
    upload.mockResolvedValue({ data: { path: "user-1/photo.jpg" }, error: null });
    const { result } = renderRetry();
    act(() => {
      result.current.openRetryMediaDialog(post);
      result.current.setRetryMediaFiles([new File(["image"], "photo.jpg", { type: "image/jpeg" })]);
    });
    await act(async () => { await result.current.handleRetryWithNewMedia(); });
    expect(update).toHaveBeenCalledWith({ media_file_ids: ["media-1"] });
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", { body: { post_id: post.id, mode: "retry" } });
    expect(from).not.toHaveBeenCalledWith("platform_posts");
    expect(result.current.retryMediaDialogPost).toBeNull();
  });
});
