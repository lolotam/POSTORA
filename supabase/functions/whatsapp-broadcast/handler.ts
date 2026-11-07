// Broadcast send. The request only starts a background job; the job sends the broadcast in
// time-bounded chunks (chunk.ts). This file decides whether the broadcast may start and
// answers 202 with the job id.
import { z } from "npm:zod@3.23.8";
import { resolveWhatsAppCloudCredentials, type WhatsAppAccountRow } from "../_shared/whatsappCloudCredentials.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { runInBackground } from "../_shared/background.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface BroadcastRecipient {
  id: string;
  phone_number: string;
}

export interface BroadcastRecord {
  id: string;
  status: string;
  name: string;
  template_name: string;
  template_components: { language?: string; body_parameters?: string[] } | null;
  sent_count: number;
  failed_count: number;
}

export interface BroadcastDeps {
  authenticate(req: Request): Promise<{ userId: string } | { response: Response }>;
  loadBroadcast(userId: string, broadcastId: string): Promise<BroadcastRecord | null>;
  loadWhatsAppAccounts(userId: string): Promise<WhatsAppAccountRow[]>;
  /** null means the read failed, not that there are no recipients. */
  hasPendingRecipients(broadcastId: string): Promise<boolean | null>;
  /** The job id, or null when the broadcast was already started. Throws on a database error. */
  startBroadcast(userId: string, broadcastId: string): Promise<string | null>;
  kickWorker(): Promise<void>;
  logRecipientReadFailure(userId: string, broadcastId: string): Promise<void>;
}

const broadcastBodySchema = z.object({ broadcast_id: z.string().uuid() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleWhatsAppBroadcast(req: Request, deps: BroadcastDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = await deps.authenticate(req);
    if ("response" in auth) return auth.response;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "broadcast_id required" }, 400);
    }
    const parsed = broadcastBodySchema.safeParse(raw);
    if (!parsed.success) return json({ error: "broadcast_id required" }, 400);
    const { broadcast_id } = parsed.data;

    const broadcast = await deps.loadBroadcast(auth.userId, broadcast_id);
    if (!broadcast) return json({ error: "Broadcast not found" }, 404);
    if (broadcast.status !== "pending") {
      return json({ error: `Broadcast already ${broadcast.status}` }, 400);
    }

    const resolution = resolveWhatsAppCloudCredentials(await deps.loadWhatsAppAccounts(auth.userId));
    if (resolution.status !== "ok") {
      return json(
        resolution.status === "requires_cloud_api"
          ? {
            error: resolution.reason === "qr_only"
              ? "Broadcasts require a Cloud API connection. This number is connected with Direct QR, which cannot send template messages."
              : "This WhatsApp number is missing the Cloud API credentials needed to broadcast. Reconnect it from Setup.",
            code: "BROADCAST_REQUIRES_CLOUD_API",
          }
          : { error: "No connected WhatsApp Business account", code: "NO_WHATSAPP_ACCOUNT" },
        400,
      );
    }

    const hasPending = await deps.hasPendingRecipients(broadcast_id);
    if (hasPending === null) {
      await deps.logRecipientReadFailure(auth.userId, broadcast_id);
      return json({ error: "Could not read recipients" }, 500);
    }
    if (!hasPending) return json({ error: "No pending recipients" }, 400);

    // The state flip and the job insert happen in one database transaction. A null job id is the
    // loser of a double click or a second tab.
    const jobId = await deps.startBroadcast(auth.userId, broadcast_id);
    if (!jobId) return json({ error: "Broadcast already started" }, 409);

    // The kick cannot fail the request. Cron is the safety net if it is lost.
    await runInBackground("kick background-jobs-worker", () => deps.kickWorker());

    return json({ accepted: true, jobId, broadcast_id, status: "sending" }, 202);
  } catch (e) {
    console.error("[whatsapp-broadcast] send failed");
    return json({ error: sanitizeErrorMessage(e) }, 500);
  }
}
