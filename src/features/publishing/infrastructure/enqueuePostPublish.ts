import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface PublishRequest {
  postId: string;
  mode: "publish_now" | "retry";
  accountIds?: string[];
}

type RefusalReason = "not_found" | "not_publishable" | "not_retryable" | "no_targets";
type PublishAcceptance =
  | { accepted: true; alreadyRunning: boolean }
  | { accepted: false; reason: RefusalReason | "error" };

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null;
}

function isRefusal(reason: unknown): reason is RefusalReason {
  return reason === "not_found" || reason === "not_publishable" || reason === "not_retryable" || reason === "no_targets";
}

export async function enqueuePostPublish({ postId, mode, accountIds }: PublishRequest): Promise<PublishAcceptance> {
  try {
    const { data: acknowledgement, error } = await supabase.functions.invoke<unknown>("enqueue-post-publish", {
      body: { post_id: postId, mode, ...(accountIds ? { account_ids: accountIds } : {}) },
    });
    if (error instanceof FunctionsHttpError) {
      const refusal: unknown = await error.context.json();
      if (isRecord(refusal) && isRefusal(refusal.error)) return { accepted: false, reason: refusal.error };
    }
    if (error || !isRecord(acknowledgement) || acknowledgement.accepted !== true ||
      acknowledgement.post_id !== postId || acknowledgement.status !== "processing") {
      return { accepted: false, reason: "error" };
    }
    return { accepted: true, alreadyRunning: acknowledgement.already === true };
  } catch {
    // A lost acknowledgement is not proof of rejection: the durable request may still run.
    return { accepted: false, reason: "error" };
  }
}
