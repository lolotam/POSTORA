import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { supabase } from "@/integrations/supabase/client";

import { CompetitorTrackingError } from "../domain/errors";
import { SupabaseCompetitorTrackingGateway } from "../infrastructure/supabaseCompetitorTrackingGateway";

/**
 * The adapter tests use the REAL envelope shapes of the two boundaries:
 *
 *   the report boundary    { "error": { "code": "NOT_FOUND" } }
 *   the collection boundary { "error": "not_found" }
 *
 * They are different dialects on purpose, and the adapter has to read
 * them separately.
 */

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    rpc: vi.fn(),
  },
}));

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

const QUOTA = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 2,
  remaining: 3,
};

const LIST_REPORT = {
  version: 1,
  as_of: "2026-10-30T09:15:00+00:00",
  capture_timezone: "Asia/Kuwait",
  quota: QUOTA,
  next_cursor: null,
  entries: [],
};

const invokeMock = supabase.functions.invoke as unknown as Mock;
const rpcMock = supabase.rpc as unknown as Mock;

/** A PostgREST builder: it is awaitable and it accepts an abort signal. */
function rpcBuilder(data: unknown, error: unknown = null): unknown {
  const builder = {
    abortSignal: () => builder,
    then: (
      onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data, error }).then(onFulfilled, onRejected),
  };
  return builder;
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

describe("supabase competitor tracking gateway", () => {
  const gateway = new SupabaseCompetitorTrackingGateway();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("the report boundary", () => {
    it("reads a list through the report endpoint", async () => {
      invokeMock.mockResolvedValue({ data: LIST_REPORT, error: null });

      const report = await gateway.list({ state: "active" });

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [name, options] = invokeMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(name).toBe("competitor-tracking-report");
      expect(options.body).toEqual({ action: "list", state: "active" });
      expect(report.quota).toEqual(QUOTA);
    });

    it("reads a detail with the watchlist id and the period", async () => {
      invokeMock.mockResolvedValue({
        data: {
          version: 1,
          as_of: "2026-10-30T09:15:00+00:00",
          capture_timezone: "Asia/Kuwait",
          quota: QUOTA,
          next_cursor: null,
          entry: null,
          media: [],
        },
        error: null,
      });

      await gateway.detail({ watchlistId: WATCHLIST_ID, periodDays: 7 });

      const [, options] = invokeMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({
        action: "detail",
        watchlist_id: WATCHLIST_ID,
        period_days: 7,
      });
    });

    it("normalises the report's object error envelope", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({ error: { code: "NOT_FOUND" } }, 404),
      });

      await expect(gateway.list({ state: "active" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("normalises the report's unauthorized envelope", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({ error: { code: "UNAUTHORIZED" } }, 401),
      });

      await expect(gateway.list({ state: "active" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("refuses an unknown report version instead of publishing it", async () => {
      invokeMock.mockResolvedValue({
        data: { ...LIST_REPORT, version: 2 },
        error: null,
      });

      await expect(gateway.list({ state: "active" })).rejects.toMatchObject({
        code: "REPORT_UNAVAILABLE",
      });
    });

    it("refuses a malformed report instead of returning an empty list", async () => {
      invokeMock.mockResolvedValue({
        data: { ...LIST_REPORT, quota: { ...QUOTA, tracked_active: "two" } },
        error: null,
      });

      await expect(gateway.list({ state: "active" })).rejects.toMatchObject({
        code: "REPORT_UNAVAILABLE",
      });
    });
  });

  describe("the owner RPCs", () => {
    it("reads the quota through the owner RPC", async () => {
      rpcMock.mockReturnValue(rpcBuilder(QUOTA));

      const quota = await gateway.quota();

      expect(rpcMock).toHaveBeenCalledWith("read_own_competitor_quota");
      expect(quota).toEqual(QUOTA);
    });

    it("maps the quota refusal of the database to a typed error", async () => {
      rpcMock.mockReturnValue(
        rpcBuilder(null, {
          code: "23514",
          message: "COMPETITOR_QUOTA_EXCEEDED: You are tracking 5 of the 5 competitors your plan allows.",
        }),
      );

      await expect(gateway.add({ username: "northwind" })).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
    });

    it("accepts an already-tracked reply that legitimately carries no quota", async () => {
      rpcMock.mockReturnValue(
        rpcBuilder({
          watchlist_id: WATCHLIST_ID,
          username: "northwind",
          is_active: true,
          status: "ok",
          reactivated: false,
          already_tracked: true,
        }),
      );

      const result = await gateway.add({ username: "northwind" });

      expect(result.alreadyTracked).toBe(true);
      expect(result.quota).toBeNull();
    });

    it("reads the quota of a fresh add", async () => {
      rpcMock.mockReturnValue(
        rpcBuilder({
          watchlist_id: WATCHLIST_ID,
          username: "northwind",
          is_active: true,
          status: "pending",
          reactivated: false,
          already_tracked: false,
          quota: QUOTA,
        }),
      );

      const result = await gateway.add({ username: "northwind", label: null });

      expect(result.quota).toEqual(QUOTA);
      expect(rpcMock).toHaveBeenCalledWith("add_competitor_watchlist", {
        p_username: "northwind",
        p_label: null,
      });
    });

    it("removes softly: the update RPC with a false activation and a null label", async () => {
      rpcMock.mockReturnValue(
        rpcBuilder({
          watchlist_id: WATCHLIST_ID,
          username: "northwind",
          label: "Northwind",
          is_active: false,
          removed_at: "2026-10-30T10:00:00+00:00",
          status: "ok",
          quota: QUOTA,
        }),
      );

      const result = await gateway.setActive({
        watchlistId: WATCHLIST_ID,
        isActive: false,
        label: null,
      });

      expect(rpcMock).toHaveBeenCalledWith("update_competitor_watchlist", {
        p_watchlist_id: WATCHLIST_ID,
        p_label: null,
        p_is_active: false,
      });
      expect(result.isActive).toBe(false);
      expect(result.removedAt).toBe("2026-10-30T10:00:00+00:00");
    });

    it("maps a missing entry to NOT_FOUND", async () => {
      rpcMock.mockReturnValue(
        rpcBuilder(null, {
          code: "P0002",
          message: "COMPETITOR_NOT_FOUND: that competitor is not on your list",
        }),
      );

      await expect(
        gateway.setActive({ watchlistId: WATCHLIST_ID, isActive: false }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("reports an unobservable statement as indeterminate", async () => {
      rpcMock.mockReturnValue(rpcBuilder(null, { code: "", message: "fetch failed" }));

      await expect(gateway.add({ username: "northwind" })).rejects.toMatchObject({
        code: "MUTATION_INDETERMINATE",
      });
    });
  });

  describe("the collection boundary", () => {
    it("enqueues an entry and reports the accepted receipt", async () => {
      invokeMock.mockResolvedValue({
        data: {
          accepted: true,
          reason: "queued",
          job_id: "9d1f0c22-4c0a-4a1a-9a0a-3b1d2c4e5f60",
          job_generation: 3,
          status: "queued",
          captured_on: "2026-10-30",
        },
        error: null,
        response: jsonResponse({}, 202),
      });

      const result = await gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false });

      const [name, options] = invokeMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(name).toBe("competitor-snapshot-sync");
      expect(options.body).toEqual({ mode: "entry", watchlist_id: WATCHLIST_ID });
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;
      expect(result.jobId).toBe("9d1f0c22-4c0a-4a1a-9a0a-3b1d2c4e5f60");
    });

    it("uses the force mode only for an explicit retry", async () => {
      invokeMock.mockResolvedValue({
        data: { accepted: true, reason: "queued", job_id: null, job_generation: null, status: null, captured_on: null },
        error: null,
        response: jsonResponse({}, 202),
      });

      await gateway.enqueue({ watchlistId: WATCHLIST_ID, force: true });

      const [, options] = invokeMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ mode: "force", watchlist_id: WATCHLIST_ID });
    });

    it("reports a deferred collection with the retry time of the body", async () => {
      invokeMock.mockResolvedValue({
        data: {
          accepted: false,
          reason: "throttled",
          retry_after_seconds: 120,
          captured_on: "2026-10-30",
        },
        error: null,
        response: jsonResponse({}, 429),
      });

      const result = await gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false });

      expect(result.outcome).toBe("deferred");
      if (result.outcome !== "deferred") return;
      expect(result.retryAfterSeconds).toBe(120);
    });

    it("reads the Retry-After header when the body carries no retry time", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({}, 429, { "Retry-After": "90" }),
      });

      await expect(
        gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false }),
      ).rejects.toMatchObject({ code: "THROTTLED", retryAfterSeconds: 90 });
    });

    it("normalises the collection's string error envelope", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({ error: "collection_disabled" }, 503),
      });

      await expect(
        gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false }),
      ).rejects.toMatchObject({ code: "COLLECTION_DISABLED" });
    });

    it("does not read the report's object envelope as a collection code", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({ error: { code: "NOT_FOUND" } }, 503),
      });

      await expect(
        gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false }),
      ).rejects.toMatchObject({ code: "REQUEST_UNAVAILABLE" });
    });

    it("reports an unreachable collector as an indeterminate enqueue", async () => {
      invokeMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });

      await expect(
        gateway.enqueue({ watchlistId: WATCHLIST_ID, force: false }),
      ).rejects.toMatchObject({ code: "ENQUEUE_INDETERMINATE" });
    });

    it("reads a no-job status as a fact, not as a failed read", async () => {
      invokeMock.mockResolvedValue({
        data: {
          target_kind: "competitor",
          target_id: WATCHLIST_ID,
          captured_on: "2026-10-30",
          status: "none",
          job_generation: 0,
          attempts: 0,
          due_at: null,
          next_retry_at: null,
          last_attempt_at: null,
          last_success_at: null,
          reason_code: null,
          pending_operations: 0,
        },
        error: null,
        response: jsonResponse({}, 200),
      });

      const status = await gateway.status({ watchlistId: WATCHLIST_ID });

      expect(status.status).toBe("none");
      expect(status.jobGeneration).toBe(0);
    });

    it("reports a failed status read as an error, not as a no-job status", async () => {
      invokeMock.mockResolvedValue({
        data: null,
        error: new Error("http error"),
        response: jsonResponse({ error: "status_unavailable" }, 503),
      });

      await expect(gateway.status({ watchlistId: WATCHLIST_ID })).rejects.toMatchObject({
        code: "STATUS_UNAVAILABLE",
      });
    });

    it("refuses a status reply it does not understand", async () => {
      invokeMock.mockResolvedValue({
        data: { target_kind: "competitor", status: "none" },
        error: null,
        response: jsonResponse({}, 200),
      });

      await expect(gateway.status({ watchlistId: WATCHLIST_ID })).rejects.toMatchObject({
        code: "STATUS_UNAVAILABLE",
      });
    });
  });

  describe("the guards", () => {
    it("refuses a watchlist id that is not a uuid before it reaches the wire", async () => {
      await expect(
        gateway.enqueue({ watchlistId: "not-a-uuid", force: false }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("refuses a page size the report would refuse, without a round trip", async () => {
      await expect(gateway.list({ state: "active", limit: 500 })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("refuses an empty cursor without a round trip", async () => {
      await expect(gateway.list({ state: "active", cursor: "" })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("raises a typed error, never a raw string", async () => {
      invokeMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });

      await expect(gateway.list({ state: "active" })).rejects.toBeInstanceOf(
        CompetitorTrackingError,
      );
    });
  });

  describe("the abortable reads", () => {
    it("links the caller's abort signal to the read", async () => {
      let forwarded: AbortSignal | undefined;
      invokeMock.mockImplementation(
        async (_name: string, options: { signal?: AbortSignal }) => {
          forwarded = options.signal;
          return await new Promise((resolve) => {
            if (options.signal?.aborted) {
              resolve({ data: null, error: new Error("aborted") });
              return;
            }
            options.signal?.addEventListener(
              "abort",
              () => resolve({ data: null, error: new Error("aborted") }),
              { once: true },
            );
          });
        },
      );

      const controller = new AbortController();
      const pending = gateway.list({ state: "active" }, { signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(forwarded?.aborted).toBe(true);
    });

    it("raises an abort error, not a failed read, when the caller cancelled", async () => {
      invokeMock.mockResolvedValue({ data: LIST_REPORT, error: null });
      const controller = new AbortController();
      controller.abort();

      await expect(
        gateway.list({ state: "active" }, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("aborts the status read with the caller's signal too", async () => {
      invokeMock.mockResolvedValue({ data: null, error: new Error("fetch failed") });
      const controller = new AbortController();
      controller.abort();

      await expect(
        gateway.status({ watchlistId: WATCHLIST_ID }, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});
