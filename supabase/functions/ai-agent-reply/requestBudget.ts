import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/ai-fallback.ts";
import { withDeadline } from "../_shared/deadline.ts";

/** Legacy send transports do not all accept cancellation. Stop awaiting them
 * within the work budget; outbox callers then record delivery_unknown rather
 * than retrying an external send whose result this invocation cannot know. */
export function boundAgentSender(sender: (recipient: string, text: string) => Promise<string>, signal: AbortSignal) {
  return (recipient: string, text: string) => withDeadline(20_000, signal, async callSignal => {
    callSignal.throwIfAborted();
    return await sender(recipient, text);
  });
}

/** Work observes disconnects. Settlement starts after the external send; final
 * lease cleanup has a reserved budget even if settlement exhausts its own.
 * Each detached lane starts once, on its first I/O, and never renews. */
export function createAgentClients(url: string, key: string, caller: AbortSignal,
  limits = { workMs: 50_000, settlementMs: 5_000, cleanupMs: 2_000 }) {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(limits.workMs)]);
  const client = (budgetMs: number, parent?: AbortSignal) => {
    let deadline = parent;
    return createClient(url, key, { global: { fetch: (input, init) => {
      deadline ??= AbortSignal.timeout(budgetMs);
      return fetchWithTimeout(String(input), { ...init,
        signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
      }, budgetMs);
    } } });
  };
  return { signal, work: client(limits.workMs, signal),
    settlement: client(limits.settlementMs), cleanup: client(limits.cleanupMs) };
}
