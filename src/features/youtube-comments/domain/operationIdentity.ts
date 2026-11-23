/**
 * Durable local operation identity (spec 9.1, browser side).
 *
 * Before the first network call of a submit, the client writes
 * {operation_id, account, video, action, target} to browser storage scoped
 * to the signed-in user. On reload it restores the entry and asks for status
 * BEFORE rendering a composer for that target. A new key is minted only by a
 * new user gesture after the previous key reached a state the user was shown.
 *
 * Storage being unavailable does not unblock a resend: the server fences are
 * the authority. Comment text is never stored here.
 */

export type Stage4OperationAction = "create_thread" | "reply" | "edit" | "moderate";

export interface PendingStage4Operation {
  operationId: string;
  accountId: string;
  videoId: string;
  action: Stage4OperationAction;
  /** The target comment id for reply/edit/moderate; empty for create. */
  targetCommentId: string;
  createdAt: number;
}

const PREFIX = "postora:yt-stage4:ops";

function storageKey(userId: string): string {
  return `${PREFIX}:${userId}`;
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    // Probe: some environments hand out a storage that throws on any access.
    const probe = `${PREFIX}:probe`;
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function readAll(userId: string): PendingStage4Operation[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingStage4Operation =>
      !!entry && typeof entry === "object"
      && typeof (entry as PendingStage4Operation).operationId === "string"
      && typeof (entry as PendingStage4Operation).accountId === "string"
      && typeof (entry as PendingStage4Operation).videoId === "string"
      && typeof (entry as PendingStage4Operation).action === "string"
      && typeof (entry as PendingStage4Operation).targetCommentId === "string"
    );
  } catch {
    return [];
  }
}

function writeAll(userId: string, ops: PendingStage4Operation[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(userId), JSON.stringify(ops.slice(-50)));
  } catch {
    // A full or blocked storage never blocks the submit itself.
  }
}

/** Persist one operation identity. Call BEFORE the first network call. */
export function savePendingOperation(userId: string, op: PendingStage4Operation): void {
  const all = readAll(userId).filter((existing) => existing.operationId !== op.operationId);
  all.push(op);
  writeAll(userId, all);
}

/** The pending operation for one target, if any: restored before a composer renders. */
export function findPendingOperation(
  userId: string,
  target: { accountId: string; videoId: string; action: Stage4OperationAction; targetCommentId?: string },
): PendingStage4Operation | null {
  return readAll(userId).find((op) =>
    op.accountId === target.accountId
    && op.videoId === target.videoId
    && op.action === target.action
    && (target.targetCommentId === undefined || op.targetCommentId === target.targetCommentId)
  ) ?? null;
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
