/**
 * Durable local operation identity (spec 9.1, browser side).
 *
 * Before the first network call of a submit, the client writes
 * {operation_id, account, video, action, target} to browser storage scoped
 * to the signed-in user. On reload it restores the entry and asks for status
 * BEFORE rendering a composer for that target. A new key is minted only by a
 * new user gesture after the previous key reached a state the user was shown.
 *
 * Storage being unavailable does not unblock a resend: a module-level memory
 * fallback keeps identities across remounts in this tab, and the server fences
 * remain the authority. Comment text is never stored here.
 */

export type Stage4OperationAction = "create_thread" | "reply" | "edit" | "moderate";

export interface PendingStage4Operation {
  operationId: string;
  accountId: string;
  videoId: string;
  action: Stage4OperationAction;
  /** The target comment id for reply/edit/moderate; empty for create. */
  targetCommentId: string;
  /** True when reply `targetCommentId` was normalized to the canonical parent id. */
  targetIsCanonicalParent?: boolean;
  createdAt: number;
}

const PREFIX = "postora:yt-stage4:ops";
const inMemoryByUser = new Map<string, Map<string, PendingStage4Operation>>();
const unsyncedUsers = new Set<string>();

function storageKey(userId: string): string {
  return `${PREFIX}:${userId}`;
}

function unsyncedKey(userId: string): string {
  return `${PREFIX}:unsynced:${userId}`;
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    // Probe every operation the fallback relies on: any denied access means memory is authoritative.
    const probe = `${PREFIX}:probe`;
    s.setItem(probe, "1");
    s.getItem(probe);
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function memoryOperations(userId: string): PendingStage4Operation[] {
  return [...(inMemoryByUser.get(userId)?.values() ?? [])];
}

function replaceMemory(userId: string, operations: PendingStage4Operation[]): void {
  const merged = new Map<string, PendingStage4Operation>();
  for (const operation of operations) merged.set(operation.operationId, operation);
  const capped = [...merged.values()].slice(-50);
  if (capped.length === 0) {
    inMemoryByUser.delete(userId);
    return;
  }
  inMemoryByUser.set(userId, new Map(capped.map((operation) => [operation.operationId, operation])));
}

function validOperations(parsed: unknown): PendingStage4Operation[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is PendingStage4Operation =>
    !!entry && typeof entry === "object"
    && typeof (entry as PendingStage4Operation).operationId === "string"
    && typeof (entry as PendingStage4Operation).accountId === "string"
    && typeof (entry as PendingStage4Operation).videoId === "string"
    && typeof (entry as PendingStage4Operation).action === "string"
    && typeof (entry as PendingStage4Operation).targetCommentId === "string"
  );
}

function readAll(userId: string): PendingStage4Operation[] {
  const storage = safeStorage();
  if (!storage) return memoryOperations(userId);
  if (unsyncedUsers.has(userId)) {
    try {
      if (storage.getItem(unsyncedKey(userId)) === "1") {
        return memoryOperations(userId);
      }
    } catch {
      return memoryOperations(userId);
    }
    unsyncedUsers.delete(userId);
  }
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(userId));
  } catch {
    return memoryOperations(userId);
  }
  // Healthy storage is authoritative when the last write reached it.
  if (raw === null) {
    inMemoryByUser.delete(userId);
    return [];
  }
  try {
    replaceMemory(userId, validOperations(JSON.parse(raw)));
  } catch {
    inMemoryByUser.delete(userId);
  }
  return memoryOperations(userId);
}

function writeAll(userId: string, ops: PendingStage4Operation[]): void {
  replaceMemory(userId, ops);
  const storage = safeStorage();
  if (!storage) {
    unsyncedUsers.add(userId);
    return;
  }
  try {
    storage.setItem(storageKey(userId), JSON.stringify(memoryOperations(userId)));
    unsyncedUsers.delete(userId);
    try {
      storage.removeItem(unsyncedKey(userId));
    } catch {
      // Ignore marker cleanup failure after the authoritative list write succeeded.
    }
  } catch {
    // A full or blocked storage never blocks the submit itself; memory stays authoritative,
    // including when the new list is empty so stale stored entries cannot reappear.
    unsyncedUsers.add(userId);
    try {
      storage.setItem(unsyncedKey(userId), "1");
    } catch {
      // Storage is completely unwritable; safeStorage() will return null while blocked.
    }
  }
}

/** Persist one operation identity. Call BEFORE the first network call. */
export function savePendingOperation(userId: string, op: PendingStage4Operation): void {
  const all = readAll(userId).filter((existing) => existing.operationId !== op.operationId);
  all.push(op);
  writeAll(userId, all);
}

/**
 * Every pending operation for one target. An unresolved earlier submit can sit
 * beside the one in flight, so a guard has to look at all of them.
 */
export function findPendingOperations(
  userId: string,
  target: { accountId: string; videoId: string; action: Stage4OperationAction; targetCommentId?: string },
): PendingStage4Operation[] {
  return readAll(userId).filter((op) =>
    op.accountId === target.accountId
    && op.videoId === target.videoId
    && op.action === target.action
    && (target.targetCommentId === undefined || op.targetCommentId === target.targetCommentId)
  );
}

export function listPendingOperations(userId: string, accountId: string): PendingStage4Operation[] {
  return readAll(userId).filter((op) => op.accountId === accountId);
}

/** Drop an operation after its outcome was shown (or it can never be read again). */
export function clearPendingOperation(userId: string, operationId: string): void {
  writeAll(userId, readAll(userId).filter((op) => op.operationId !== operationId));
}

/** Drop everything for one account: an account switch discards stale context. */
export function clearPendingOperationsForAccount(userId: string, accountId: string): void {
  writeAll(userId, readAll(userId).filter((op) => op.accountId !== accountId));
}

export function mintOperationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for exotic hosts; uniqueness is what matters, not secrecy.
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
