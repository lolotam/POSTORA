import { fetchWithTimeout } from "../_shared/request-timeout.ts";
import { type AdminClient, type Dependencies, safeLog } from "./context.ts";
import { mapDatabaseError } from "./errors.ts";

const PROCESS_POST_TIMEOUT_MS = 50_000;

async function setDispatchState(
  admin: AdminClient,
  submissionId: string,
  from: string[],
  to: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("tiktok_review_set_dispatch_state", {
    p_submission_id: submissionId,
    p_from: from,
    p_to: to,
  });
  if (error) throw mapDatabaseError(error);
  return data === true;
}

export async function dispatchNow(
  deps: Dependencies,
  userId: string,
  submissionId: string,
  postId: string,
): Promise<void> {
  const logDispatch = (code: string) =>
    safeLog(deps, {
      event: "tiktok_review_dispatch",
      action: "submit",
      code,
      user_id: userId,
      draft_id: null,
      submission_id: submissionId,
      level: "error",
    });

  let claimed = false;
  try {
    claimed = await setDispatchState(deps.admin, submissionId, ["pending_dispatch"], "dispatching");
  } catch {
    await logDispatch("DISPATCH_CLAIM_FAILED");
    return;
  }
  if (!claimed) return;

  const run = async () => {
    try {
      const base = deps.supabaseUrl.replace(/\/$/, "");
      const response = await fetchWithTimeout(
        `${base}/functions/v1/process-post`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ post_id: postId, expected_scheduled_at: null }),
        },
        PROCESS_POST_TIMEOUT_MS,
        deps.fetch,
      );
      const httpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      const next = response.ok ? "dispatched" : "needs_attention";
      try {
        await setDispatchState(deps.admin, submissionId, ["dispatching", "publishing"], next);
      } catch {
        await logDispatch("DISPATCH_STATE_FAILED");
        return;
      }
      if (!response.ok) await logDispatch(`DISPATCH_HTTP_${httpStatus}`);
    } catch {
      try {
        await setDispatchState(deps.admin, submissionId, ["dispatching"], "unknown");
      } catch {
        await logDispatch("DISPATCH_STATE_FAILED");
      }
      await logDispatch("DISPATCH_UNKNOWN");
    }
  };

  const task = run();
  if (deps.edgeRuntime) {
    try {
      // Called on the runtime object: an unbound waitUntil loses `this`.
      deps.edgeRuntime.waitUntil(task);
      return;
    } catch {
      await task;
      return;
    }
  }
  await task;
}
