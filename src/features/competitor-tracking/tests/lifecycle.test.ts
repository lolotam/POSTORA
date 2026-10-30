import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";

import { CompetitorTrackingError } from "../domain/errors";
import type {
  CompetitorAddResult,
  CompetitorCollectionStatus,
  CompetitorEnqueueResult,
  CompetitorSetActiveResult,
  CompetitorTrackingGateway,
} from "../application/ports";
import { reactivateCompetitor } from "../application/reactivateCompetitor";
import { removeCompetitor } from "../application/removeCompetitor";
import { trackCompetitor } from "../application/trackCompetitor";

/**
 * The lifecycle tests use a FAKE port, never a mocked HTTP client: the
 * order of the calls, the number of the calls and what happens when one
 * of them fails is the behaviour under test.
 */

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

const QUOTA = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 2,
  remaining: 3,
};

const ADDED: CompetitorAddResult = {
  watchlistId: WATCHLIST_ID,
  username: "northwind",
  isActive: true,
  status: "pending",
  reactivated: false,
  alreadyTracked: false,
  quota: QUOTA,
};

const ACCEPTED: CompetitorEnqueueResult = {
  outcome: "accepted",
  reason: "queued",
  jobId: "9d1f0c22-4c0a-4a1a-9a0a-3b1d2c4e5f60",
  jobGeneration: 3,
  status: "queued",
  capturedOn: "2026-10-30",
};

const SET_ACTIVE: CompetitorSetActiveResult = {
  watchlistId: WATCHLIST_ID,
  username: "northwind",
  label: "Northwind",
  isActive: true,
  removedAt: null,
  status: "pending",
  quota: QUOTA,
};

type GatewayMock = {
  list: MockedFunction<CompetitorTrackingGateway["list"]>;
  detail: MockedFunction<CompetitorTrackingGateway["detail"]>;
  quota: MockedFunction<CompetitorTrackingGateway["quota"]>;
  status: MockedFunction<CompetitorTrackingGateway["status"]>;
  add: MockedFunction<CompetitorTrackingGateway["add"]>;
  setActive: MockedFunction<CompetitorTrackingGateway["setActive"]>;
  enqueue: MockedFunction<CompetitorTrackingGateway["enqueue"]>;
};

function createGateway(): GatewayMock {
  return {
    list: vi.fn<CompetitorTrackingGateway["list"]>(),
    detail: vi.fn<CompetitorTrackingGateway["detail"]>(),
    quota: vi.fn<CompetitorTrackingGateway["quota"]>(),
    status: vi.fn<CompetitorTrackingGateway["status"]>(),
    add: vi.fn<CompetitorTrackingGateway["add"]>(),
    setActive: vi.fn<CompetitorTrackingGateway["setActive"]>(),
    enqueue: vi.fn<CompetitorTrackingGateway["enqueue"]>(),
  };
}

describe("competitor tracking lifecycle", () => {
  let gateway: GatewayMock;

  beforeEach(() => {
    gateway = createGateway();
  });

  describe("tracking a handle", () => {
    it("saves the entry and then enqueues the collection exactly once", async () => {
      gateway.add.mockResolvedValue(ADDED);
      gateway.enqueue.mockResolvedValue(ACCEPTED);

      const result = await trackCompetitor({ gateway }, { username: "@Northwind" });

      expect(result.outcome).toBe("saved_and_queued");
      expect(gateway.add).toHaveBeenCalledTimes(1);
      expect(gateway.add).toHaveBeenCalledWith({ username: "northwind", label: null });
      expect(gateway.enqueue).toHaveBeenCalledTimes(1);
      expect(gateway.enqueue).toHaveBeenCalledWith({ watchlistId: WATCHLIST_ID, force: false });
      if (result.outcome !== "saved_and_queued") return;
      expect(result.quota).toEqual(QUOTA);
    });

    it("does not enqueue an already-active handle and does not force a refresh", async () => {
      gateway.add.mockResolvedValue({
        ...ADDED,
        alreadyTracked: true,
        status: "ok",
        quota: null,
      });

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("already_tracked");
      expect(gateway.enqueue).not.toHaveBeenCalled();
      if (result.outcome !== "already_tracked") return;
      // The already-tracked reply legitimately carries no quota.
      expect(result.quota).toBeNull();
    });

    it("refuses a handle the database would refuse, without spending a call", async () => {
      const result = await trackCompetitor({ gateway }, { username: "a..b" });

      expect(result.outcome).toBe("failure");
      if (result.outcome !== "failure") return;
      expect(result.error.code).toBe("INVALID_HANDLE");
      expect(gateway.add).not.toHaveBeenCalled();
      expect(gateway.enqueue).not.toHaveBeenCalled();
    });

    it("makes no enqueue when the quota rejects the save", async () => {
      gateway.add.mockRejectedValue(
        new CompetitorTrackingError("QUOTA_EXCEEDED", "the limit is reached"),
      );

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("failure");
      if (result.outcome !== "failure") return;
      expect(result.error.code).toBe("QUOTA_EXCEEDED");
      expect(gateway.enqueue).not.toHaveBeenCalled();
    });

    it("preserves the saved row when the enqueue is refused", async () => {
      gateway.add.mockResolvedValue(ADDED);
      gateway.enqueue.mockRejectedValue(
        new CompetitorTrackingError("COLLECTION_DISABLED", "collection is off"),
      );

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("saved_enqueue_unconfirmed");
      if (result.outcome !== "saved_enqueue_unconfirmed") return;
      expect(result.watchlistId).toBe(WATCHLIST_ID);
      expect(result.quota).toEqual(QUOTA);
      expect(result.reason).toBe("refused");
      expect(result.error.code).toBe("COLLECTION_DISABLED");
      // The saved row is never rolled back and the add is never repeated.
      expect(gateway.add).toHaveBeenCalledTimes(1);
      expect(gateway.enqueue).toHaveBeenCalledTimes(1);
    });

    it("reports a deferred collection with the server's retry time", async () => {
      gateway.add.mockResolvedValue(ADDED);
      gateway.enqueue.mockResolvedValue({
        outcome: "deferred",
        reason: "throttled",
        retryAfterSeconds: 120,
        capturedOn: "2026-10-30",
      });

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("saved_enqueue_unconfirmed");
      if (result.outcome !== "saved_enqueue_unconfirmed") return;
      expect(result.reason).toBe("throttled");
      expect(result.error.code).toBe("THROTTLED");
      expect(result.error.retryAfterSeconds).toBe(120);
    });

    it("never replays a lost enqueue", async () => {
      gateway.add.mockResolvedValue(ADDED);
      gateway.enqueue.mockRejectedValue(
        new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "the outcome is unknown"),
      );

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("saved_enqueue_unconfirmed");
      if (result.outcome !== "saved_enqueue_unconfirmed") return;
      expect(result.reason).toBe("indeterminate");
      expect(gateway.enqueue).toHaveBeenCalledTimes(1);
      expect(gateway.add).toHaveBeenCalledTimes(1);
    });

    it("reports an unobservable save as indeterminate, not as a failure", async () => {
      gateway.add.mockRejectedValue(
        new CompetitorTrackingError("MUTATION_INDETERMINATE", "the outcome is unknown"),
      );

      const result = await trackCompetitor({ gateway }, { username: "northwind" });

      expect(result.outcome).toBe("indeterminate");
      expect(gateway.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("removing a handle", () => {
    it("soft-removes through the activation flag and never deletes anything", async () => {
      gateway.setActive.mockResolvedValue({
        ...SET_ACTIVE,
        isActive: false,
        removedAt: "2026-10-30T10:00:00+00:00",
      });

      const result = await removeCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("removed");
      expect(gateway.setActive).toHaveBeenCalledTimes(1);
      expect(gateway.setActive).toHaveBeenCalledWith({
        watchlistId: WATCHLIST_ID,
        isActive: false,
        label: null,
      });
      // A removal never enqueues and never touches the collection.
      expect(gateway.enqueue).not.toHaveBeenCalled();
    });

    it("sends a null label, so the stored label is preserved", async () => {
      gateway.setActive.mockResolvedValue(SET_ACTIVE);

      await removeCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      const call = gateway.setActive.mock.calls[0]?.[0] as { label: string | null };
      expect(call.label).toBeNull();
    });

    it("reports an unobservable removal as indeterminate", async () => {
      gateway.setActive.mockRejectedValue(
        new CompetitorTrackingError("MUTATION_INDETERMINATE", "the outcome is unknown"),
      );

      const result = await removeCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("indeterminate");
      expect(gateway.setActive).toHaveBeenCalledTimes(1);
    });

    it("reports a refusal as a failure", async () => {
      gateway.setActive.mockRejectedValue(
        new CompetitorTrackingError("NOT_FOUND", "that competitor is not on the list"),
      );

      const result = await removeCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("failure");
      if (result.outcome !== "failure") return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("reactivating a handle", () => {
    it("activates the SAME entry and then enqueues it once, without the force flag", async () => {
      gateway.setActive.mockResolvedValue(SET_ACTIVE);
      gateway.enqueue.mockResolvedValue(ACCEPTED);

      const result = await reactivateCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("reactivated_and_queued");
      expect(gateway.setActive).toHaveBeenCalledWith({
        watchlistId: WATCHLIST_ID,
        isActive: true,
        label: null,
      });
      expect(gateway.enqueue).toHaveBeenCalledTimes(1);
      expect(gateway.enqueue).toHaveBeenCalledWith({ watchlistId: WATCHLIST_ID, force: false });
    });

    it("keeps the reactivated entry when the collection cannot be confirmed", async () => {
      gateway.setActive.mockResolvedValue(SET_ACTIVE);
      gateway.enqueue.mockRejectedValue(
        new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "the outcome is unknown"),
      );

      const result = await reactivateCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("reactivated_enqueue_unconfirmed");
      if (result.outcome !== "reactivated_enqueue_unconfirmed") return;
      expect(result.watchlistId).toBe(WATCHLIST_ID);
      expect(result.reason).toBe("indeterminate");
    });

    it("makes no enqueue when the quota rejects the reactivation", async () => {
      gateway.setActive.mockRejectedValue(
        new CompetitorTrackingError("QUOTA_EXCEEDED", "the limit is reached"),
      );

      const result = await reactivateCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(result.outcome).toBe("failure");
      expect(gateway.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("the port contract", () => {
    it("keeps the gateway a read, a mutation and a collection apart", () => {
      const gateway: CompetitorTrackingGateway = createGateway();

      expect(typeof gateway.list).toBe("function");
      expect(typeof gateway.detail).toBe("function");
      expect(typeof gateway.quota).toBe("function");
      expect(typeof gateway.status).toBe("function");
      expect(typeof gateway.add).toBe("function");
      expect(typeof gateway.setActive).toBe("function");
      expect(typeof gateway.enqueue).toBe("function");
    });

    it("never asks the gateway for a hard delete", async () => {
      gateway.setActive.mockResolvedValue(SET_ACTIVE);

      await removeCompetitor({ gateway }, { watchlistId: WATCHLIST_ID });

      expect(Object.keys(gateway)).not.toContain("delete");
      expect(gateway.setActive).toHaveBeenCalledWith({
        watchlistId: WATCHLIST_ID,
        isActive: false,
        label: null,
      });
    });
  });
});

describe("competitor tracking collection status", () => {
  it("is a fact about the data, not an error", () => {
    const status: CompetitorCollectionStatus = {
      targetKind: "competitor",
      targetId: WATCHLIST_ID,
      capturedOn: "2026-10-30",
      status: "none",
      jobGeneration: 0,
      attempts: 0,
      dueAt: null,
      nextRetryAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      reasonCode: null,
      pendingOperations: 0,
    };

    expect(status.status).toBe("none");
  });
});
