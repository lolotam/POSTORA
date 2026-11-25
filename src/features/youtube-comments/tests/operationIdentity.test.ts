import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPendingOperation,
  clearPendingOperationsForAccount,
  findPendingOperation,
  listPendingOperations,
  mintOperationId,
  savePendingOperation,
} from "../domain/operationIdentity";

const USER = "user-1";
const ACCOUNT = "account-1";

function op(overrides: Partial<Parameters<typeof savePendingOperation>[1]> = {}) {
  return {
    operationId: mintOperationId(),
    accountId: ACCOUNT,
    videoId: "vid-1",
    action: "create_thread" as const,
    targetCommentId: "",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("durable operation identity", () => {
  beforeEach(() => {
    localStorage.clear();
    listPendingOperations(USER, ACCOUNT);
  });

  it("round-trips an operation for the same user and target", () => {
    const entry = op();
    savePendingOperation(USER, entry);
    expect(findPendingOperation(USER, { accountId: ACCOUNT, videoId: "vid-1", action: "create_thread" })).toEqual(entry);
    expect(findPendingOperation(USER, { accountId: ACCOUNT, videoId: "vid-1", action: "create_thread", targetCommentId: "" })).toEqual(entry);
  });

  it("scopes by account, video, action and target comment", () => {
    savePendingOperation(USER, op());
    savePendingOperation(USER, op({ action: "reply", targetCommentId: "c-1", videoId: "vid-2" }));
    expect(findPendingOperation(USER, { accountId: ACCOUNT, videoId: "vid-1", action: "reply", targetCommentId: "c-1" })).toBeNull();
    expect(findPendingOperation(USER, { accountId: "other", videoId: "vid-1", action: "create_thread" })).toBeNull();
    expect(findPendingOperation("other-user", { accountId: ACCOUNT, videoId: "vid-1", action: "create_thread" })).toBeNull();
  });

  it("clears one operation and everything for one account", () => {
    const a = op();
    const b = op({ action: "edit", targetCommentId: "c-9" });
    savePendingOperation(USER, a);
    savePendingOperation(USER, b);
    clearPendingOperation(USER, a.operationId);
    expect(listPendingOperations(USER, ACCOUNT)).toHaveLength(1);
    clearPendingOperationsForAccount(USER, ACCOUNT);
    expect(listPendingOperations(USER, ACCOUNT)).toHaveLength(0);
  });

  it("replaces a duplicate operation id instead of duplicating it", () => {
    const entry = op();
    savePendingOperation(USER, entry);
    savePendingOperation(USER, { ...entry, videoId: "vid-changed" });
    expect(listPendingOperations(USER, ACCOUNT)).toHaveLength(1);
    expect(listPendingOperations(USER, ACCOUNT)[0].videoId).toBe("vid-changed");
  });

  it("keeps and clears an operation in memory while storage throws", () => {
    const entry = op();
    const failing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: failing, configurable: true });
    try {
      expect(() => savePendingOperation(USER, entry)).not.toThrow();
      expect(listPendingOperations(USER, ACCOUNT)).toEqual([entry]);
      clearPendingOperation(USER, entry.operationId);
      expect(listPendingOperations(USER, ACCOUNT)).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  });

  it("invalidates the memory fallback when healthy storage has been cleared", () => {
    const failing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: failing, configurable: true });
    try {
      savePendingOperation(USER, op());
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }

    localStorage.clear();
    expect(listPendingOperations(USER, ACCOUNT)).toEqual([]);
  });

  it("ignores corrupt storage content instead of crashing", () => {
    localStorage.setItem(`postora:yt-stage4:ops:${USER}`, "not json at all");
    expect(listPendingOperations(USER, ACCOUNT)).toEqual([]);
  });

  it("keeps the new identity in memory when the 1-byte probe succeeds but the full payload exceeds storage quota", () => {
    const first = op({ operationId: "op-1" });
    const second = op({ operationId: "op-2" });
    savePendingOperation(USER, first);

    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function quotaLimitedSetItem(this: Storage, key: string, value: string): void {
      if (key === `postora:yt-stage4:ops:${USER}`) {
        throw new Error("QuotaExceededError");
      }
      return nativeSetItem.call(this, key, value);
    };
    try {
      savePendingOperation(USER, second);
      expect(listPendingOperations(USER, ACCOUNT)).toEqual([first, second]);
      clearPendingOperation(USER, first.operationId);
      expect(listPendingOperations(USER, ACCOUNT)).toEqual([second]);
    } finally {
      Storage.prototype.setItem = nativeSetItem;
    }
  });
});
