// Cron entrypoint for the WhatsApp disconnect watcher (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). The watcher is the authority on whether an
// Evolution WhatsApp session is gone: it polls Evolution directly, so it works even when the
// connection.update webhook never fires.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { sanitizedError } from "../_shared/errorContext.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import { redactSensitive } from "../_shared/logging.ts";
import { dispatchDisconnectAlert } from "./dispatch.ts";
import { runWatch, type Episode, type WatchCandidate } from "./run.ts";
import { readConnectionState } from "./stateReader.ts";

/**
 * A candidate polled less than this many minutes ago is skipped: the cron runs every five
 * minutes, so a candidate that was just checked must not be polled again.
 */
const POLL_FRESHNESS_MINUTES = 5;

/** The instance row the candidate query returns. */
interface CandidateRow {
  social_account_id: string;
  instance_name: string;
  last_polled_at: string | null;
  /** The embedded account row: one-to-one in the database, an array in some clients. */
  social_accounts: { id: string; is_active: boolean } | { id: string; is_active: boolean }[] | null;
}

/**
 * Whether the account row is still active.
 *
 * The flag only guards the clear. An account whose flag cannot be read is treated as
 * active: the inner join guarantees the embedded row exists, so this is only the
 * fallback for a shape the client answered differently -- and a stale episode on a
 * connected account is worse than a missing clear on a disconnected one.
 */
function isActiveOf(row: CandidateRow): boolean {
  const embedded = row.social_accounts;
  const record = Array.isArray(embedded) ? embedded[0] : embedded;
  if (!record || typeof record !== "object") return true;
  return record.is_active !== false;
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[whatsapp-disconnect-watch] Supabase configuration missing");
      return new Response(
        JSON.stringify({ error: "watcher not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const api = createEvolutionApi();

    const summary = await runWatch({
      /**
       * The poll time lives on the instance row, so the query starts there. PostgREST can
       * order by the top level table's column but not by an embedded resource's column, and
       * the instance row IS the top level table here. The account side filters ride on the
       * embedded social_accounts row, which is a one-to-one foreign key from the instance.
       */
      async listCandidates(limit: number): Promise<WatchCandidate[]> {
        const { data, error } = await admin
          .from("whatsapp_evolution_instances")
          .select("social_account_id, instance_name, last_polled_at, social_accounts!inner(id, is_active)")
          .eq("social_accounts.platform", "whatsapp")
          .eq("social_accounts.connection_mode", "evolution_qr")
          // is_active is deliberately NOT a filter: a disconnected Evolution account is
          // inactive by design (the webhook deactivates it), so filtering on is_active
          // would skip exactly the accounts this watcher exists to alert on. The
          // deliberate-disconnect marker below is what excludes an account the owner
          // disconnected on purpose.
          .not("social_accounts.platform_user_id", "like", "pending_%")
          .not("social_accounts.platform_user_id", "like", "retired_%")
          .is("social_accounts.account_metadata->whatsapp_user_disconnected_at", null)
          .order("last_polled_at", { ascending: true, nullsFirst: true })
          .limit(limit);
        if (error) throw error;

        const cutoff = Date.now() - POLL_FRESHNESS_MINUTES * 60_000;
        const candidates: WatchCandidate[] = [];
        for (const row of (data ?? []) as unknown as CandidateRow[]) {
          if (row.last_polled_at !== null) {
            const polledAt = Date.parse(row.last_polled_at);
            // An unreadable poll time is treated as never polled: the account is checked.
            if (Number.isFinite(polledAt) && polledAt > cutoff) continue;
          }
          candidates.push({
            id: row.social_account_id,
            instance_name: row.instance_name,
            is_active: isActiveOf(row),
          });
        }
        return candidates;
      },
      async readState(instanceName: string): Promise<string | null> {
        // A read that cannot be answered raises: an unreachable Evolution is a failed
        // account, not a state. Answering null here would record the account as polled
        // and skip it, and the outage would then go unnoticed.
        return await readConnectionState(api, instanceName);
      },
      async observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null> {
        const { data, error } = await admin.rpc("observe_whatsapp_disconnect_state", {
          p_account_id: accountId,
          p_state: state,
          p_terminal: terminal,
        });
        if (error) throw error;
        return (data as Episode | null) ?? null;
      },
      async clear(accountId: string): Promise<void> {
        const { error } = await admin.rpc("clear_whatsapp_disconnect_episode", {
          p_account_id: accountId,
        });
        if (error) throw error;
      },
      async markFlagged(accountId: string, episodeId: string, reason: string): Promise<boolean> {
        // Conditional on the observed episode still being open (and the account not marked as
        // deliberately disconnected), so a reconnect between observe and flag always wins.
        const { data, error } = await admin.rpc("flag_whatsapp_disconnect_episode", {
          p_account_id: accountId,
          p_episode_id: episodeId,
          p_reason: reason,
        });
        if (error) throw error;
        return data === true;
      },
      async dispatchAlert(accountId: string) {
        // The same service-role bearer relationship refresh-tokens has with
        // send-token-failure-alert: the sender is an internal function, never a browser one.
        // The dispatch carries its own timeout, and the sender's summary decides whether
        // an alert really went out: it answers 200 even when a recipient failed.
        return await dispatchDisconnectAlert({
          url: `${supabaseUrl}/functions/v1/send-whatsapp-disconnect-alert`,
          serviceRoleKey,
          accountId,
        });
      },
      async markPolled(instanceName: string, at: Date): Promise<void> {
        const { error } = await admin
          .from("whatsapp_evolution_instances")
          .update({ last_polled_at: at.toISOString() })
          .eq("instance_name", instanceName);
        if (error) throw error;
      },
      monotonicNow: () => performance.now(),
      now: () => new Date(),
    });

    console.log(`[whatsapp-disconnect-watch] ${JSON.stringify(summary)}`);
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // The raw provider/database error can carry an address, a phone number or a provider
    // payload, so it never reaches the log as it is. What is logged is a sanitized code
    // plus the operational context needed to find the run again.
    console.error(
      "[whatsapp-disconnect-watch] run failed",
      redactSensitive({
        event: "whatsapp_disconnect_watch_failed",
        ...sanitizedError(error),
      }),
    );
    return new Response(
      JSON.stringify({ error: "watcher run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
