/**
 * An in-memory store of the drafts a view of one account holds: the text the
 * owner typed into a reply or edit editor, and whether that editor is open.
 *
 * It exists because the editor lives inside the row, and a row can leave the
 * screen while the owner is typing (a Refresh returns every reply chain to page
 * one, and every row of page two unmounts). The store outlives the row.
 *
 * Comment text is never written to browser storage (spec: nothing the owner
 * typed is stored), so this is memory only and a reload loses it, as before.
 * No browser API is used here.
 */

export type DraftKind = "reply" | "edit";

export interface DraftEntry {
  text: string;
  open: boolean;
  /** The thread the comment belongs to: what lets a block say a draft waits on a row it has not loaded. */
  parentCommentId: string;
}

/** The key names account, binding generation, comment id and kind, so a draft never crosses a binding. */
export function draftKey(accountId: string, generation: number, commentId: string, kind: DraftKind): string {
  return `${accountId}|g${generation}|${commentId}|${kind}`;
}

export interface Stage4DraftStore {
  get(key: string): DraftEntry | undefined;
  set(key: string, entry: DraftEntry): void;
  remove(key: string): void;
  /** The drafts of one thread, with the comment id and kind they belong to. */
  forParent(parentCommentId: string): Array<{ key: string; commentId: string; kind: DraftKind; entry: DraftEntry }>;
  /** Forget every draft written under another binding generation. */
  keepGeneration(generation: number): void;
  subscribe(listener: () => void): () => void;
  /** Changes on every write: what `useSyncExternalStore` reads. */
  version(): number;
}

export function createStage4DraftStore(): Stage4DraftStore {
  const entries = new Map<string, DraftEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const parse = (key: string) => {
    const [, generation, commentId, kind] = key.split("|");
    return { generation: generation.slice(1), commentId, kind: kind as DraftKind };
  };
  return {
    get: (key) => entries.get(key),
    set(key, entry) {
      entries.set(key, entry);
      changed();
    },
    remove(key) {
      if (entries.delete(key)) changed();
    },
    forParent(parentCommentId) {
      const out: Array<{ key: string; commentId: string; kind: DraftKind; entry: DraftEntry }> = [];
      for (const [key, entry] of entries) {
        if (entry.parentCommentId !== parentCommentId) continue;
        const { commentId, kind } = parse(key);
        out.push({ key, commentId, kind, entry });
      }
      return out;
    },
    keepGeneration(generation) {
      let removed = false;
      for (const key of [...entries.keys()]) {
        if (parse(key).generation !== String(generation)) {
          entries.delete(key);
          removed = true;
        }
      }
      if (removed) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}
