import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSettled, recoverOperation } from "../application/recoverOperation";
import type { YouTubeCommentsGateway } from "../application/ports";
import { listPendingOperations, savePendingOperation, type PendingStage4Operation } from "../domain/operationIdentity";
import { YouTubeCommentsError } from "../domain/errors";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function pendingOperation(operationId: string): PendingStage4Operation {
  const operation: PendingStage4Operation = {
    operationId, accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "", createdAt: Date.now(),
  };
  savePendingOperation(USER, operation);
  return operation;
}

function gatewayThatAnswers(answer: () => Promise<unknown>): YouTubeCommentsGateway {
  return { operationStatus: vi.fn(answer) } as unknown as YouTubeCommentsGateway;
}

beforeEach(() => localStorage.clear());

describe("recoverOperation", () => {
  it.each([
    { label: "a confirmed receipt", answer: () => Promise.resolve({ state: "confirmed" }), settled: true, unavailable: false },
    { label: "a refused receipt", answer: () => Promise.resolve({ state: "refused" }), settled: true, unavailable: false },
    { label: "an indeterminate receipt (still unresolved)", answer: () => Promise.resolve({ state: "indeterminate" }), settled: false, unavailable: false },
    { label: "not_found (the binding changed)", answer: () => Promise.reject(new YouTubeCommentsError("not_found")), settled: true, unavailable: false },
    { label: "binding_changed", answer: () => Promise.reject(new YouTubeCommentsError("binding_changed")), settled: true, unavailable: false },
    { label: "a 503 upstream (the server could not read the receipt)", answer: () => Promise.reject(new YouTubeCommentsError("upstream")), settled: false, unavailable: true },
    { label: "a 429", answer: () => Promise.reject(new YouTubeCommentsError("rate_limited")), settled: false, unavailable: true },
    { label: "a dropped network", answer: () => Promise.reject(new Error("Failed to fetch")), settled: false, unavailable: true },
  ])("classifies $label without touching the stored identity", async ({ answer, settled, unavailable }) => {
    const operation = pendingOperation("op-1");
    const result = await recoverOperation(gatewayThatAnswers(answer), ACCOUNT, operation);
    expect({ settled: result.settled, unavailable: result.unavailable }).toEqual({ settled, unavailable });
    // Reading never clears: only the view that has the result may do that.
    expect(listPendingOperations(USER, ACCOUNT)).toHaveLength(1);
  });

  it("clearSettled forgets exactly the identities whose outcome is definite", async () => {
    const confirmed = await recoverOperation(gatewayThatAnswers(() => Promise.resolve({ state: "confirmed" })), ACCOUNT, pendingOperation("op-done"));
    const flaky = await recoverOperation(gatewayThatAnswers(() => Promise.reject(new YouTubeCommentsError("upstream"))), ACCOUNT, pendingOperation("op-flaky"));
    clearSettled(USER, [confirmed, flaky]);
    expect(listPendingOperations(USER, ACCOUNT).map((op) => op.operationId)).toEqual(["op-flaky"]);
  });
});
