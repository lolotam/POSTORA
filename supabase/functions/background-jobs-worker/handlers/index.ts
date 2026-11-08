// The job kinds the worker knows how to run. Each handler turns one job into one chunk of
// work inside the deadline the worker hands it.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { createBroadcastChunkPorts } from "../../whatsapp-broadcast/chunkDeps.ts";
import { runBroadcastChunk } from "../../whatsapp-broadcast/chunk.ts";
import type { JobHandler } from "../worker.ts";
import { runInstagramStory } from "./instagramStory.ts";
import { createInstagramStoryPorts } from "./instagramStoryDeps.ts";

export function backgroundJobHandlers(admin: SupabaseClient): Record<string, JobHandler> {
  return {
    instagram_story: (job, deadlineMs) => runInstagramStory(job, createInstagramStoryPorts(admin), deadlineMs),
    whatsapp_broadcast_chunk: async (job, deadlineMs) => {
      const outcome = await runBroadcastChunk(createBroadcastChunkPorts(admin), {
        broadcastId: String(job.payload.broadcast_id),
        userId: job.user_id,
        deadlineMs,
      });
      if (outcome.kind === "continue") return outcome;
      if (outcome.kind === "done") return { kind: "done", result: outcome.result };
      return { kind: "failed", error: outcome.error, retryable: outcome.retryable };
    },
  };
}
